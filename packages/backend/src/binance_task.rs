// packages/backend/src/binance_task.rs
use super::{
    config::Config,
    state::{AppState, RoomIndex, SubscriptionCommand},
    types::{
        BinanceKlineDataWrapper, BinanceStreamWrapper, BinanceTickDataWrapper, KlineBroadcastData,
        KlineTick,
    },
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use socketioxide::SocketIo;
use std::{collections::HashSet, sync::Arc, time::SystemTime};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc::UnboundedReceiver,
    time::{interval, sleep, Duration},
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

const LOW_VOLUME_PRICE_DEVIATION_THRESHOLD: f64 = 2.0;
const LOW_VOLUME_THRESHOLD: f64 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TaskType {
    Kline,
    Tick,
}

impl std::fmt::Display for TaskType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TaskType::Kline => write!(f, "KLINE_MGR"),
            TaskType::Tick => write!(f, "TICK_MGR"),
        }
    }
}

// ✨ 核心入口：启动全局管理器
pub async fn start_global_manager(
    task_type: TaskType,
    io: SocketIo,
    config: Arc<Config>,
    app_state: AppState,
    room_index: Option<RoomIndex>,
    mut cmd_rx: UnboundedReceiver<SubscriptionCommand>,
) {
    info!("🚀 [STARTUP] Starting Global {}...", task_type);
    let mut active_streams: HashSet<String> = HashSet::new();

    loop {
        // 无限重连机制
        let result = connect_and_serve(
            task_type,
            &io,
            &config,
            &app_state,
            &room_index,
            &mut cmd_rx,
            &mut active_streams,
        )
        .await;

        match result {
            Ok(_) => warn!("🔁 [MANAGER {}] Disconnected gracefully. Reconnecting in 3s...", task_type),
            Err(e) => error!("🔁 [MANAGER {}] Connection crash: {:#?}. Retrying in 5s...", task_type, e),
        }
        sleep(Duration::from_secs(5)).await;
    }
}

async fn connect_and_serve(
    task_type: TaskType,
    io: &SocketIo,
    config: &Config,
    app_state: &AppState,
    room_index: &Option<RoomIndex>,
    cmd_rx: &mut UnboundedReceiver<SubscriptionCommand>,
    active_streams: &mut HashSet<String>,
) -> Result<()> {
    // 1. 建立连接 (复用 HTTP 隧道逻辑)
    let stream = establish_http_tunnel(task_type, config).await?;
    let host = Url::parse(&config.binance_wss_url)?.host_str().unwrap_or_default().to_string();
    let tls_stream = wrap_stream_with_tls(stream, &host).await?;

    let mut request = config.binance_wss_url.as_str().into_client_request()?;
    request.headers_mut().insert("User-Agent", "Rust/Backend GlobalManager".parse()?);

    let (ws_stream, response) = client_async_with_config(request, tls_stream, None)
        .await.context("WebSocket handshake failed")?;

    info!("✅ [MANAGER {}] Connected! Status: {}", task_type, response.status());

    let (mut write, mut read) = ws_stream.split();

    // 2. 断线重连后恢复订阅
    if !active_streams.is_empty() {
        info!("🔄 [MANAGER {}] Resubscribing {} streams...", task_type, active_streams.len());
        let params: Vec<&str> = active_streams.iter().map(|s| s.as_str()).collect();
        // 分批订阅，防止请求过大
        for chunk in params.chunks(50) {
            let msg = serde_json::json!({
                "method": "SUBSCRIBE",
                "params": chunk,
                "id": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis()
            });
            write.send(Message::Text(msg.to_string().into())).await?;
            sleep(Duration::from_millis(100)).await;
        }
    }

    let mut heartbeat = interval(config.heartbeat_interval);

    // 3. 事件循环
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                write.send(Message::Ping(vec![].into())).await?;
            }

            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SubscriptionCommand::Subscribe(stream)) => {
                        if !active_streams.contains(&stream) {
                            info!("📥 [CMD {}] Subscribing: {}", task_type, stream);
                            let msg = serde_json::json!({
                                "method": "SUBSCRIBE",
                                "params": [stream],
                                "id": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis()
                            });
                            write.send(Message::Text(msg.to_string().into())).await?;
                            active_streams.insert(stream);
                        }
                    },
                    Some(SubscriptionCommand::Unsubscribe(stream)) => {
                        if active_streams.contains(&stream) {
                            info!("📤 [CMD {}] Unsubscribing: {}", task_type, stream);
                            let msg = serde_json::json!({
                                "method": "UNSUBSCRIBE",
                                "params": [stream],
                                "id": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis()
                            });
                            write.send(Message::Text(msg.to_string().into())).await?;
                            active_streams.remove(&stream);
                        }
                    },
                    None => return Err(anyhow!("Command channel closed")),
                }
            }

            msg_result = read.next() => {
                match msg_result {
                    Some(Ok(msg)) => {
                        match msg {
                            Message::Text(text) => handle_payload(task_type, &text, io, app_state, room_index).await,
                            Message::Ping(p) => { write.send(Message::Pong(p)).await?; }
                            Message::Close(_) => return Ok(()),
                            _ => {}
                        }
                    },
                    Some(Err(e)) => return Err(e.into()),
                    None => return Ok(()),
                }
            }
        }
    }
}

async fn handle_payload(
    task_type: TaskType,
    text: &str,
    io: &SocketIo,
    app_state: &AppState,
    room_index: &Option<RoomIndex>,
) {
    if text.contains("\"result\":null") { return; }

    match task_type {
        TaskType::Kline => {
            // 处理 Kline 数据：直接解析 Stream Name 找到对应房间
            if let Ok(wrapper) = serde_json::from_str::<BinanceStreamWrapper<BinanceKlineDataWrapper>>(text) {
                // stream format: kl@poolID_address_interval
                let stream_parts: Vec<&str> = wrapper.stream.split('@').collect();
                if stream_parts.len() == 2 {
                    let params: Vec<&str> = stream_parts[1].split('_').collect();
                    if params.len() == 3 {
                        let pool_id = params[0];
                        let address = params[1];
                        let interval = params[2];
                        let room_key = format!("kl@{}@{}@{}", pool_id, address.to_lowercase(), interval);
                        
                        let kline = parse_kline(&wrapper.data.kline_data.values);
                        // Kline 是权威数据，更新内存并广播
                        update_room_and_broadcast(io, app_state, &room_key, kline).await;
                    }
                }
            }
        }
        TaskType::Tick => {
            // 处理 Tick 数据：使用 RoomIndex 进行 O(1) 路由
            if let Ok(wrapper) = serde_json::from_str::<BinanceStreamWrapper<BinanceTickDataWrapper>>(text) {
                let tick = &wrapper.data.tick_data;
                let stream_parts: Vec<&str> = wrapper.stream.split('@').collect();

                if stream_parts.len() == 2 {
                    let params: Vec<&str> = stream_parts[1].split('_').collect();
                    if params.len() >= 2 {
                        let tracked_address = params[1]; // stream 中的地址
                        
                        // 简单的价格验证逻辑
                        let price = if tick.t0a.eq_ignore_ascii_case(tracked_address) { tick.t0pu } 
                                    else if tick.t1a.eq_ignore_ascii_case(tracked_address) { tick.t1pu } 
                                    else { return; };
                        
                        let usd_volume = tick.v;

                        // ✨ 核心：利用索引找到该 Token 对应的所有房间 (1m, 15m, 1h...)
                        if let Some(index) = room_index {
                            if let Some(room_keys) = index.get(&tracked_address.to_lowercase()) {
                                for room_key in room_keys.iter() {
                                    if let Some(entry) = app_state.get(room_key) {
                                        let mut kline_guard = entry.value().current_kline.lock().await;
                                        if let Some(kline) = kline_guard.as_mut() {
                                            // 价格异常过滤
                                            if kline.close > 0.0 {
                                                let ratio = if price > kline.close { price / kline.close } else { kline.close / price };
                                                if ratio > LOW_VOLUME_PRICE_DEVIATION_THRESHOLD && usd_volume < LOW_VOLUME_THRESHOLD {
                                                    continue;
                                                }
                                            }
                                            // 更新价格 (不更新 Volume，防止重复计算)
                                            kline.high = kline.high.max(price);
                                            kline.low = kline.low.min(price);
                                            kline.close = price;

                                            // 广播
                                            broadcast_data(io, room_key, kline.clone()).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

fn parse_kline(values: &(String, String, String, String, String, String)) -> KlineTick {
    KlineTick {
        time: DateTime::from_timestamp(values.5.parse::<i64>().unwrap_or_default() / 1000, 0)
            .unwrap_or_default()
            .with_timezone(&Utc),
        open: values.0.parse().unwrap_or_default(),
        high: values.1.parse().unwrap_or_default(),
        low: values.2.parse().unwrap_or_default(),
        close: values.3.parse().unwrap_or_default(),
        volume: values.4.parse().unwrap_or_default(),
    }
}

async fn update_room_and_broadcast(io: &SocketIo, app_state: &AppState, room_key: &str, new_kline: KlineTick) {
    if let Some(room) = app_state.get(room_key) {
        *room.current_kline.lock().await = Some(new_kline.clone());
        broadcast_data(io, room_key, new_kline).await;
    }
}

async fn broadcast_data(io: &SocketIo, room_name: &str, kline: KlineTick) {
    let broadcast_data = KlineBroadcastData {
        room: room_name.to_string(),
        data: kline,
    };
    io.to(room_name.to_string()).emit("kline_update", &broadcast_data).await.ok();
}

// 建立 TCP 代理连接
async fn establish_http_tunnel(task_type: TaskType, config: &Config) -> Result<TcpStream> {
    let url_obj = Url::parse(&config.binance_wss_url)?;
    let host = url_obj.host_str().unwrap_or_default();
    let port = url_obj.port_or_known_default().unwrap_or(443);
    let target_addr = format!("{}:{}", host, port);

    if config.proxy_addr.is_empty() || config.proxy_addr == "none" {
         return TcpStream::connect(target_addr).await.context("Direct connection failed");
    }

    let mut stream = TcpStream::connect(&config.proxy_addr).await.context("HTTP proxy connection failed")?;
    let connect_req = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", target_addr, target_addr);
    stream.write_all(connect_req.as_bytes()).await.context("Failed to send CONNECT request")?;
    
    let mut buf = vec![0; 1024];
    let n = stream.read(&mut buf).await.context("Failed to read proxy response")?;
    let response = String::from_utf8_lossy(&buf[..n]);

    if !response.starts_with("HTTP/1.1 200") {
        return Err(anyhow!("❌ [MANAGER {}] Proxy CONNECT failed: {}", task_type, response.trim()));
    }
    Ok(stream)
}

async fn wrap_stream_with_tls(stream: TcpStream, host: &str) -> Result<tokio_native_tls::TlsStream<TcpStream>> {
    let tls_connector = native_tls::TlsConnector::builder().build()?;
    let tokio_tls_connector = TokioTlsConnector::from(tls_connector);
    tokio_tls_connector.connect(host, stream).await.context("TLS Handshake failed")
}