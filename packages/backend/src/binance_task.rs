// packages/backend/src/binance_task.rs

use super::{
    config::Config,
    types::{
        BinanceKlineDataWrapper, BinanceStreamWrapper, BinanceTickDataWrapper, KlineBroadcastData,
        KlineTick,
    },
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use socketioxide::SocketIo;
use std::{sync::Arc, time::SystemTime};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
    time::interval,
};
use tokio_native_tls::TlsConnector as TokioTlsConnector;
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{client::IntoClientRequest, Message},
    WebSocketStream,
};
use tracing::{error, info, warn};
use url::Url;

type WsStream = WebSocketStream<tokio_native_tls::TlsStream<TcpStream>>;
type WsWrite = SplitSink<WsStream, Message>;
type WsRead = futures_util::stream::SplitStream<WsStream>;

const LOW_VOLUME_PRICE_DEVIATION_THRESHOLD: f64 = 2.0;
const LOW_VOLUME_THRESHOLD: f64 = 10.0;

pub async fn binance_websocket_task(
    io: SocketIo,
    room_name: String,
    symbol: String,
    config: Arc<Config>,
    // ✨ 接收共享的状态
    current_kline: Arc<Mutex<Option<KlineTick>>>,
) {
    let log_display_name = {
        let parts: Vec<&str> = room_name.split('@').collect();
        if parts.len() == 4 {
            format!("{}@{}@{}@{}", parts[0], parts[1], &symbol, parts[3])
        } else {
            room_name.clone()
        }
    };

    let address = match room_name.split('@').nth(2) {
        Some(addr) => addr.to_lowercase(),
        None => {
            error!(
                "❌ [TASK INIT FAILED] Invalid room name format: {}. Cannot extract address. Aborting task.",
                log_display_name
            );
            return;
        }
    };
    let address = Arc::new(address);

    loop {
        match connect_and_run(&io, &room_name, &log_display_name, address.clone(), &config, current_kline.clone()).await {
            Ok(_) => warn!(
                "🔁 [TASK {}] Disconnected gracefully. Reconnecting...",
                log_display_name
            ),
            Err(e) => error!(
                "🔁 [TASK {}] Connection failed: {:#?}. Retrying in 3s...",
                log_display_name, e
            ),
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

async fn connect_and_run(
    io: &SocketIo,
    room_name: &str,
    log_display_name: &str,
    address: Arc<String>,
    config: &Config,
    current_kline: Arc<Mutex<Option<KlineTick>>>, 
) -> Result<()> {
    let stream = establish_http_tunnel(log_display_name, config).await?;
    let host = Url::parse(&config.binance_wss_url)?
        .host_str()
        .unwrap_or_default()
        .to_string();
    let tls_stream = wrap_stream_with_tls(stream, &host).await?;

    let mut request = config.binance_wss_url.as_str().into_client_request()?;
    let headers = request.headers_mut();

    headers.insert("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36".parse()?);
    headers.insert("Origin", "https://web3.binance.com".parse()?);
    headers.insert("Accept-Encoding", "gzip, deflate, br, zstd".parse()?);
    headers.insert("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8".parse()?);
    headers.insert("Pragma", "no-cache".parse()?);
    headers.insert("Cache-Control", "no-cache".parse()?);

    let (ws_stream, response) = client_async_with_config(request, tls_stream, None)
        .await
        .context("WebSocket handshake failed")?;
    info!(
        "✅ [TASK {}] WebSocket handshake successful. Status: {}",
        log_display_name,
        response.status()
    );

    let (mut write, mut read) = ws_stream.split();
    subscribe_all(&mut write, room_name, log_display_name).await?;

    message_loop(
        io,
        room_name,
        log_display_name,
        config,
        &mut write,
        &mut read,
        current_kline, 
        address,
    )
    .await
}

async fn subscribe_all(
    write: &mut WsWrite,
    kline_room_name: &str,
    log_display_name: &str,
) -> Result<()> {
    let parts: Vec<&str> = kline_room_name.split('@').collect();
    if parts.len() != 4 {
        return Err(anyhow!(
            "Invalid kline room name format: {}",
            kline_room_name
        ));
    }
    let pool_id = parts[1];
    let address = parts[2];

    let tick_param = format!("tx@{}_{}", pool_id, address);
    let tick_request_id = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_millis();
    let tick_subscribe_msg = serde_json::json!({
        "id": tick_request_id,
        "method": "SUBSCRIBE",
        "params": [tick_param]
    });
    info!(
        "📤 [SEND SUB {}] Tick Stream Payload: {}",
        log_display_name, tick_subscribe_msg
    );
    write
        .send(Message::Text(tick_subscribe_msg.to_string().into()))
        .await?;

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let kline_request_id =
        SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis() + 1;
    let kline_subscribe_msg = serde_json::json!({
        "id": kline_request_id,
        "method": "SUBSCRIBE",
        "params": [kline_room_name]
    });
    info!(
        "📤 [SEND SUB {}] Kline Stream Payload: {}",
        log_display_name, kline_subscribe_msg
    );
    write
        .send(Message::Text(kline_subscribe_msg.to_string().into()))
        .await?;

    Ok(())
}

async fn message_loop(
    io: &SocketIo,
    room_name: &str,
    log_display_name: &str,
    config: &Config,
    write: &mut WsWrite,
    read: &mut WsRead,
    current_kline: Arc<Mutex<Option<KlineTick>>>,
    address: Arc<String>,
) -> Result<()> {
    let mut heartbeat = interval(config.heartbeat_interval);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                // info!("[HEARTBEAT {}] Sending Ping...", log_display_name);
                write.send(Message::Ping(vec![].into())).await.context("Failed to send heartbeat Ping")?;
            }
            msg_result = read.next() => {
                match msg_result {
                    Some(Ok(msg)) => {
                        let should_continue = handle_message(msg, io, room_name, log_display_name, write, current_kline.clone(), &address).await?;
                        if !should_continue {
                            break;
                        }
                    },
                    Some(Err(e)) => return Err(e.into()),
                    None => break,
                }
            }
        }
    }
    warn!("[TASK {}] Message loop exited.", log_display_name);
    Ok(())
}

async fn handle_message(
    msg: Message,
    io: &SocketIo,
    room_name: &str,
    log_display_name: &str,
    write: &mut WsWrite,
    current_kline: Arc<Mutex<Option<KlineTick>>>,
    tracked_address: &str,
) -> Result<bool> {
    match msg {
        Message::Text(text) if !text.is_empty() => {
            if text.contains("\"stream\":\"kl@") {
                match serde_json::from_str::<BinanceStreamWrapper<BinanceKlineDataWrapper>>(&text) {
                    Ok(wrapper) => {
                        let values = &wrapper.data.kline_data.values;
                        let timestamp_seconds = values.5.parse::<i64>().unwrap_or_default() / 1000;
                        let new_kline = KlineTick {
                            time: DateTime::from_timestamp(timestamp_seconds, 0).unwrap_or_default().with_timezone(&Utc),
                            open: values.0.parse().unwrap_or_default(),
                            high: values.1.parse().unwrap_or_default(),
                            low: values.2.parse().unwrap_or_default(),
                            close: values.3.parse().unwrap_or_default(),
                            volume: values.4.parse().unwrap_or_default(),
                        };
                        
                        // ✨ Step 6: 这里就是 WebSocket K 线数据到达的地方
                        // 它会更新/替换掉我们通过 HTTP 注入的那一根
                        //info!("🌊 [WS KLINE {}] Incoming Update. Time: {}, Close: {}", log_display_name, new_kline.time, new_kline.close);
                        
                        broadcast_update(io, room_name, new_kline.clone()).await;
                        *current_kline.lock().await = Some(new_kline);
                    },
                    Err(e) => {
                        error!("❌ [KLINE PARSE ERROR {}] Error: {}. Raw: {}", log_display_name, e, text);
                    }
                }
            } else if text.contains("\"stream\":\"tx@") {
                match serde_json::from_str::<BinanceStreamWrapper<BinanceTickDataWrapper>>(&text) {
                    Ok(wrapper) => {
                        let tick = &wrapper.data.tick_data;

                        // ✨ 逻辑修复：根据当前监听的地址是 t0 还是 t1，选择正确的数量和价格
                        // tick.v 是 USD 价值，不应该直接累加到 kline.volume
                        let (price, token_amount) = if tick.t0a.eq_ignore_ascii_case(tracked_address) {
                            (tick.t0pu, tick.a0)
                        } else if tick.t1a.eq_ignore_ascii_case(tracked_address) {
                            (tick.t1pu, tick.a1)
                        } else {
                            // 理论上不会发生，除非订阅错位
                            warn!("⚠️ [TX MISMATCH {}] Tracked: {}, T0: {}, T1: {}", log_display_name, tracked_address, tick.t0a, tick.t1a);
                            return Ok(true);
                        };
                        
                        // 保留 USD Volume 用于垃圾数据过滤
                        let usd_volume = tick.v;
                        
                        let mut kline_guard = current_kline.lock().await;
                        if let Some(kline) = kline_guard.as_mut() {
                            let last_price = kline.close;

                            if last_price > 0.0 {
                                let price_ratio = if price > last_price { price / last_price } else { last_price / price };
                                // 过滤逻辑仍然使用 USD Volume (tick.v)，这很合理
                                if price_ratio > LOW_VOLUME_PRICE_DEVIATION_THRESHOLD && usd_volume < LOW_VOLUME_THRESHOLD {
                                    warn!(
                                        "🚫 [REJECT SPIKE {}] Price jump {:.2}x with low vol ${:.4}. Last: {}, New: {}",
                                        log_display_name, price_ratio, usd_volume, last_price, price
                                    );
                                    return Ok(true);
                                }
                            }

                            kline.high = kline.high.max(price);
                            kline.low = kline.low.min(price);
                            kline.close = price;
                            
                            // ✨ 核心修复：累加的是 Token 数量
                            kline.volume += token_amount;
                            
                            // ✨ 开启调试日志，确认数值是否正确
                            // 例如：P: 6.26, Amt: 0.16, USD: 1.04
                            info!("⚡ [TX {}] P: {:.4}, Amt+: {:.6} (Total: {:.2}), USD: {:.2}", 
                                log_display_name, price, token_amount, kline.volume, usd_volume);
                            
                            broadcast_update(io, room_name, kline.clone()).await;
                        }
                    },
                    Err(_e) => { 
                        // error!("❌ [TICK PARSE ERROR {}] Error: {}. Raw: {}", log_display_name, e, text);
                    }
                }
            } else if text.contains("result") {
                info!(
                    "✅ [CONFIRM {}] Subscription active. Server said: {}",
                    log_display_name, text
                );
            } else {
                // warn!("❓ [UNHANDLED MSG {}] {}", log_display_name, text);
            }
        }
        Message::Ping(ping_data) => {
            write
                .send(Message::Pong(ping_data))
                .await
                .context("Failed to send Pong")?;
        }
        Message::Close(close_frame) => {
            warn!(
                "🛑 [TASK {}] Received Close frame: {:?}",
                log_display_name, close_frame
            );
            return Ok(false);
        }
        _ => {}
    }
    Ok(true)
}

async fn broadcast_update(io: &SocketIo, room_name: &str, kline: KlineTick) {
    let broadcast_data = KlineBroadcastData {
        room: room_name.to_string(),
        data: kline,
    };
    if let Err(e) = io
        .to(room_name.to_string())
        .emit("kline_update", &broadcast_data)
        .await
    {
        error!(
            "❌ [BROADCAST FAIL {}] {:?}",
            room_name, e
        );
    }
}

async fn establish_http_tunnel(log_display_name: &str, config: &Config) -> Result<TcpStream> {
    let url_obj = Url::parse(&config.binance_wss_url)?;
    let host = url_obj.host_str().unwrap_or_default();
    let port = url_obj.port_or_known_default().unwrap_or(443);
    let target_addr = format!("{}:{}", host, port);

    // info!("connecting to proxy...");
    let mut stream = TcpStream::connect(&config.proxy_addr)
        .await
        .context("HTTP proxy connection failed")?;
    let connect_req = format!(
        "CONNECT {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        target_addr, target_addr
    );
    stream
        .write_all(connect_req.as_bytes())
        .await
        .context("Failed to send CONNECT request")?;

    let mut buf = vec![0; 1024];
    let n = stream
        .read(&mut buf)
        .await
        .context("Failed to read proxy response")?;

    let response = String::from_utf8_lossy(&buf[..n]);

    if !response.starts_with("HTTP/1.1 200") {
        return Err(anyhow!(
            "❌ [TASK {}] Proxy CONNECT failed: {}",
            log_display_name,
            response.trim()
        ));
    }
    Ok(stream)
}

async fn wrap_stream_with_tls(
    stream: TcpStream,
    host: &str,
) -> Result<tokio_native_tls::TlsStream<TcpStream>> {
    let tls_connector = native_tls::TlsConnector::builder().build()?;
    let tokio_tls_connector = TokioTlsConnector::from(tls_connector);
    tokio_tls_connector
        .connect(host, stream)
        .await
        .context("TLS Handshake failed")
}