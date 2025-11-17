// packages/backend/src/binance_task.rs
use super::{
    config::Config,
    types::{BinanceStreamWrapper, KlineBroadcastData, KlineTick},
};
use anyhow::{anyhow, Context, Result};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use socketioxide::SocketIo;
use std::{sync::Arc, time::SystemTime}; // 修正：移除了错误的 UNIX_EPOCH 导入
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
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

/// 连接到 Binance WebSocket 并处理数据的主任务循环。
pub async fn binance_websocket_task(io: SocketIo, room_name: String, config: Arc<Config>) {
    loop {
        info!("[TASK {}] Attempting to connect...", room_name);
        match connect_and_run(&io, &room_name, &config).await {
            Ok(_) => warn!("[TASK {}] Disconnected gracefully. Reconnecting...", room_name),
            Err(e) => error!("[TASK {}] Connection failed: {:#?}. Retrying...", room_name, e),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
}

/// 执行一次完整的连接、订阅和消息处理流程。
async fn connect_and_run(io: &SocketIo, room_name: &str, config: &Config) -> Result<()> {
    let stream = establish_http_tunnel(room_name, config).await?;
    let host = Url::parse(&config.binance_wss_url)?
        .host_str()
        .unwrap_or_default()
        .to_string();
    let tls_stream = wrap_stream_with_tls(stream, &host).await?;

    let mut request = config.binance_wss_url.as_str().into_client_request()?;
    let headers = request.headers_mut();
    headers.insert("User-Agent", "Mozilla/5.0...".parse()?);
    headers.insert("Origin", "https://web3.binance.com".parse()?);

    let (ws_stream, response) = client_async_with_config(request, tls_stream, None)
        .await
        .context("WebSocket handshake failed")?;
    info!("✅ [TASK {}] WebSocket handshake successful. Status: {}", room_name, response.status());

    let (mut write, mut read) = ws_stream.split();
    subscribe(&mut write, room_name).await?;
    message_loop(io, room_name, config, &mut write, &mut read).await
}

async fn subscribe(write: &mut WsWrite, room_name: &str) -> Result<()> {
    // 修正: 使用 SystemTime::UNIX_EPOCH
    let request_id = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis();
    let subscribe_msg = serde_json::json!({ "id": request_id, "method": "SUBSCRIBE", "params": [room_name] });
    // 修正: tungstenite::Message::Text 现在需要一个 Into<Utf8Bytes>，String 可以 .into()
    write.send(Message::Text(subscribe_msg.to_string().into())).await?;
    info!("👍 [TASK {}] Subscription message sent with ID: {}", room_name, request_id);
    Ok(())
}

async fn message_loop(
    io: &SocketIo,
    room_name: &str,
    config: &Config,
    write: &mut WsWrite,
    read: &mut WsRead,
) -> Result<()> {
    let mut heartbeat = interval(config.heartbeat_interval);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                // 修正: tungstenite::Message::Ping 现在需要一个 Into<Bytes>，vec![] 可以 .into()
                write.send(Message::Ping(vec![].into())).await.context("Failed to send heartbeat Ping")?;
            }
            msg_result = read.next() => {
                match msg_result {
                    Some(Ok(msg)) => {
                        if !handle_message(msg, io, room_name, write).await? {
                            break; // 收到Close帧，正常退出
                        }
                    },
                    Some(Err(e)) => return Err(e.into()), // 出现错误，向上传播
                    None => break, // Stream结束
                }
            }
        }
    }
    warn!("[TASK {}] Message loop exited.", room_name);
    Ok(())
}

/// 返回 `Ok(false)` 表示连接应终止。
async fn handle_message(msg: Message, io: &SocketIo, room_name: &str, write: &mut WsWrite) -> Result<bool> {
    match msg {
        Message::Text(text) if !text.is_empty() => {
            if let Ok(wrapper) = serde_json::from_str::<BinanceStreamWrapper>(&text) {
                let tick_data = KlineTick {
                    time: wrapper.data.d.u.5.parse::<i64>().unwrap_or_default() / 1000,
                    open: wrapper.data.d.u.0.parse().unwrap_or_default(),
                    high: wrapper.data.d.u.1.parse().unwrap_or_default(),
                    low: wrapper.data.d.u.2.parse().unwrap_or_default(),
                    close: wrapper.data.d.u.3.parse().unwrap_or_default(),
                    volume: wrapper.data.d.u.4.parse().unwrap_or_default(),
                };
                let broadcast_data = KlineBroadcastData { room: room_name.to_string(), data: tick_data };
                // 修正: .emit() 方法现在需要一个引用 &T
                if let Err(e) = io.to(room_name.to_string()).emit("kline_update", &broadcast_data).await {
                    error!("[TASK {}] Failed to broadcast kline update: {:?}", room_name, e);
                }
            } else if text.contains("result") {
                info!("[TASK {}] Received subscription confirmation: {}", room_name, text);
            }
        }
        Message::Ping(ping_data) => {
            write.send(Message::Pong(ping_data)).await.context("Failed to send Pong")?;
        }
        Message::Close(close_frame) => {
            warn!("[TASK {}] Received Close frame: {:?}", room_name, close_frame);
            return Ok(false); // 信号：退出循环
        }
        _ => {}
    }
    Ok(true) // 信号：继续循环
}

async fn establish_http_tunnel(room_name: &str, config: &Config) -> Result<TcpStream> {
    let url_obj = Url::parse(&config.binance_wss_url)?;
    let host = url_obj.host_str().unwrap_or_default();
    let port = url_obj.port_or_known_default().unwrap_or(443);
    let target_addr = format!("{}:{}", host, port);

    let mut stream = TcpStream::connect(&config.proxy_addr).await.context("HTTP proxy connection failed")?;
    let connect_req = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\n\r\n", target_addr, target_addr);
    stream.write_all(connect_req.as_bytes()).await.context("Failed to send CONNECT request")?;

    let mut buf = vec![0; 1024];
    let n = stream.read(&mut buf).await.context("Failed to read proxy response")?;
    let response = String::from_utf8_lossy(&buf[..n]);
    if !response.starts_with("HTTP/1.1 200") {
        return Err(anyhow!("[TASK {}] Proxy CONNECT failed: {}", room_name, response.trim()));
    }
    Ok(stream)
}

async fn wrap_stream_with_tls(stream: TcpStream, host: &str) -> Result<tokio_native_tls::TlsStream<TcpStream>> {
    let tls_connector = native_tls::TlsConnector::builder().build()?;
    let tokio_tls_connector = TokioTlsConnector::from(tls_connector);
    tokio_tls_connector.connect(host, stream).await.context("TLS Handshake failed")
}