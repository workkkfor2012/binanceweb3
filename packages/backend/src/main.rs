// packages/backend/src/main.rs
use axum::{
    extract::Query,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json as AxumJson, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use hex;
use native_tls::TlsConnector;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use socketioxide::{
    extract::{Data, SocketRef},
    socket::Sid,
    SocketIo,
};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    task::JoinHandle,
    time::interval,
};
use tokio_native_tls::TlsConnector as TokioTlsConnector;
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{
        client::IntoClientRequest,
        Message,
    },
};
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use url::Url;


// --- 常量 ---
const CACHE_DIR: &str = "./image_cache";
const BINANCE_WSS_URL: &str = "wss://nbstream.binance.com/w3w/stream";
const PROXY_ADDR: &str = "127.0.0.1:1080";
const HEARTBEAT_INTERVAL_SECONDS: u64 = 20;

// --- 类型定义 ---
#[derive(Debug, Deserialize, Clone)]
struct KlineSubscribePayload {
    address: String,
    chain: String,
    interval: String,
}

#[derive(Debug, Deserialize)]
struct BinanceStreamWrapper {
    stream: String,
    data: BinanceKlineData,
}

#[derive(Debug, Deserialize)]
struct BinanceKlineData {
    d: BinanceKlineDetail,
}

#[derive(Debug, Deserialize)]
struct BinanceKlineDetail {
    u: (String, String, String, String, String, String),
}


#[derive(Debug, Serialize, Clone)]
struct KlineBroadcastData {
    room: String,
    data: KlineTick,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KlineTick {
    time: i64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}
struct Room {
    clients: HashSet<Sid>,
    task_handle: JoinHandle<()>,
}
type AppState = Arc<DashMap<String, Room>>;
static KLINE_ROOMS: Lazy<AppState> = Lazy::new(|| Arc::new(DashMap::new()));
#[derive(Debug, Deserialize)]
struct ImageProxyQuery {
    url: String,
}
#[derive(Serialize, Deserialize)]
struct CacheMeta {
    content_type: String,
}

// --- Socket.IO 处理器 (无变化) ---
async fn on_socket_connect(socket: SocketRef, io: SocketIo) {
    info!("🔌 [Socket.IO] Client connected: {}", socket.id);
    let io_for_broadcast = io.clone();
    socket.on(
        "data-update",
        move |s: SocketRef, payload: Data<serde_json::Value>| async move {
            info!(
                "[Socket.IO] Received 'data-update' from {}. Broadcasting 'data-broadcast'...",
                s.id
            );
            if let Err(e) = io_for_broadcast.emit("data-broadcast", &payload.0).await {
                error!("[Socket.IO] Failed to broadcast data: {:?}", e);
            }
        },
    );
    let io_for_kline_task = io.clone();
    socket.on(
        "subscribe_kline",
        move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| async move {
            let room_name = format!("kl@14@{}@{}", payload.address, payload.interval);
            info!("🔼 [SUB] Client {} subscribing to room: {}", s.id, room_name);
            s.join(room_name.clone());

            KLINE_ROOMS.entry(room_name.clone()).or_insert_with(|| {
                info!("✨ [ROOM] First subscriber for '{}'. Creating room and spawning task...", room_name);
                let task_handle = tokio::spawn(
                    binance_websocket_task(io_for_kline_task.clone(), room_name.clone()),
                );
                Room {
                    clients: HashSet::new(),
                    task_handle,
                }
            }).value_mut().clients.insert(s.id);

            if let Some(room) = KLINE_ROOMS.get(&room_name) {
                info!("✓ [SUB] Client {} added to room '{}'. Total clients in room: {}", s.id, room_name, room.clients.len());
            }
        },
    );
    socket.on(
        "unsubscribe_kline",
        move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| async move {
            let room_name = format!("kl@14@{}@{}", payload.address, payload.interval);
            info!("🔽 [UNSUB] Client {} unsubscribing from room: {}", s.id, room_name);
            s.leave(room_name.clone());
            if let Some(mut room) = KLINE_ROOMS.get_mut(&room_name) {
                room.clients.remove(&s.id);
                info!("✓ [UNSUB] Client {} removed from room '{}'. Remaining clients: {}", s.id, room_name, room.clients.len());
                if room.clients.is_empty() {
                    info!("🗑️ [ROOM] Last client left room '{}'. Aborting task.", room_name);
                    room.task_handle.abort();
                }
            }
            KLINE_ROOMS.retain(|_, v| !v.clients.is_empty());
        },
    );
    socket.on_disconnect(move |s: SocketRef| async move {
        info!("[Socket.IO] Client disconnected: {}", s.id);
        let mut empty_rooms = Vec::new();
        for mut room in KLINE_ROOMS.iter_mut() {
            if room.value_mut().clients.remove(&s.id) {
                info!("🧹 [CLEANUP] Removed disconnected client {} from room '{}'. Remaining: {}", s.id, room.key(), room.clients.len());
                if room.clients.is_empty() {
                    empty_rooms.push(room.key().clone());
                }
            }
        }
        for room_name in empty_rooms {
             if let Some((_, room)) = KLINE_ROOMS.remove(&room_name) {
                info!("🗑️ [ROOM] Room '{}' is now empty after client disconnect. Aborting task.", room_name);
                room.task_handle.abort();
            }
        }
    });
}

// --- 后台任务 ---
async fn binance_websocket_task(io: SocketIo, room_name: String) {
    info!("🚀 [TASK {}] Starting with HTTP Proxy {}...", room_name, PROXY_ADDR);
    
    loop {
        // --- 代理和TLS连接部分 (无变化) ---
        let url_obj = match Url::parse(BINANCE_WSS_URL) { Ok(u) => u, Err(e) => { error!("[TASK {}] Invalid WebSocket URL: {:?}", room_name, e); return; } };
        let host = url_obj.host_str().unwrap_or_default();
        let port = url_obj.port_or_known_default().unwrap_or(443);
        let target_addr = format!("{}:{}", host, port);
        info!("[TASK {}] Connecting to HTTP proxy...", room_name);
        let mut stream = match TcpStream::connect(PROXY_ADDR).await { Ok(s) => s, Err(e) => { error!("[TASK {}] HTTP proxy connection failed: {:?}. Retrying...", room_name, e); tokio::time::sleep(tokio::time::Duration::from_secs(5)).await; continue; } };
        let connect_req = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", target_addr, target_addr);
        if let Err(e) = stream.write_all(connect_req.as_bytes()).await { error!("[TASK {}] Failed to send CONNECT request: {:?}. Retrying...", room_name, e); tokio::time::sleep(tokio::time::Duration::from_secs(5)).await; continue; }
        let mut buf = vec![0; 1024];
        let n = match stream.read(&mut buf).await { Ok(n) => n, Err(e) => { error!("[TASK {}] Failed to read proxy response: {:?}. Retrying...", room_name, e); tokio::time::sleep(tokio::time::Duration::from_secs(5)).await; continue; } };
        let response = String::from_utf8_lossy(&buf[..n]);
        if !response.starts_with("HTTP/1.1 200") { error!("[TASK {}] Proxy CONNECT failed: {}. Retrying...", room_name, response.trim()); tokio::time::sleep(tokio::time::Duration::from_secs(5)).await; continue; }
        info!("[TASK {}] HTTP tunnel established.", room_name);
        let tls_connector = TokioTlsConnector::from(TlsConnector::builder().build().expect("Failed to create TlsConnector"));
        let tls_stream = match tls_connector.connect(host, stream).await { Ok(s) => s, Err(e) => { error!("[TASK {}] TLS Handshake failed: {:?}. Retrying...", room_name, e); tokio::time::sleep(tokio::time::Duration::from_secs(5)).await; continue; } };

        // --- 伪装请求头 (无变化) ---
        let mut request = BINANCE_WSS_URL.into_client_request().unwrap();
        let headers = request.headers_mut();
        headers.insert("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36".parse().unwrap());
        headers.insert("Origin", "https://web3.binance.com".parse().unwrap());
        headers.insert("Accept-Encoding", "gzip, deflate, br, zstd".parse().unwrap());
        headers.insert("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8".parse().unwrap());
        
        info!("[TASK {}] Performing WebSocket handshake with FULL disguised headers...", room_name);
        
        match client_async_with_config(request, tls_stream, None).await {
            Ok((ws_stream, response)) => {
                info!("✅ [TASK {}] WebSocket handshake successful. Response Status: {}", room_name, response.status());
                let (mut write, mut read) = ws_stream.split();
                
                let request_id = SystemTime::now().duration_since(UNIX_EPOCH).expect("Time went backwards").as_millis();
                let subscribe_msg = serde_json::json!({ "id": request_id, "method": "SUBSCRIBE", "params": [&room_name] });
                let msg_to_send = Message::Text(subscribe_msg.to_string().into());
                
                if let Err(e) = write.send(msg_to_send).await {
                    error!("[TASK {}] Failed to send subscription message: {:?}", room_name, e);
                    continue;
                }
                info!("👍 [TASK {}] Subscription message sent with ID: {}", room_name, request_id);

                let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECONDS));
                
                loop {
                    tokio::select! {
                        _ = heartbeat.tick() => {
                            let ping_msg = Message::Ping(vec![].into());
                            if let Err(e) = write.send(ping_msg).await {
                                error!("[TASK {}] Failed to send heartbeat Ping: {:?}", room_name, e);
                                break;
                            }
                        }

                        msg_result = read.next() => {
                            match msg_result {
                                Some(Ok(msg)) => {
                                    match msg {
                                        Message::Text(text) => {
                                            if text.is_empty() { continue; }
                                            
                                            if let Ok(wrapper) = serde_json::from_str::<BinanceStreamWrapper>(&text) {
                                                let data = &wrapper.data;
                                                // ✨ 核心修正: 为每个 .parse() 添加类型注解
                                                let tick_data = KlineTick {
                                                    time: data.d.u.5.parse::<i64>().unwrap_or_default() / 1000,
                                                    open: data.d.u.0.parse::<f64>().unwrap_or_default(),
                                                    high: data.d.u.1.parse::<f64>().unwrap_or_default(),
                                                    low: data.d.u.2.parse::<f64>().unwrap_or_default(),
                                                    close: data.d.u.3.parse::<f64>().unwrap_or_default(),
                                                    volume: data.d.u.4.parse::<f64>().unwrap_or_default(),
                                                };
                                                info!("[KLINE DATA {}] Parsed tick: {:?}", room_name, tick_data);
                                                let broadcast_data = KlineBroadcastData { room: room_name.clone(), data: tick_data };
                                                if let Err(e) = io.to(room_name.clone()).emit("kline_update", &broadcast_data).await {
                                                    error!("[TASK {}] Failed to broadcast kline update: {:?}", room_name, e);
                                                }
                                            } else if text.contains("result") {
                                                info!("[TASK {}] Received subscription confirmation: {}", room_name, text);
                                            } else {
                                                warn!("[TASK {}] Received unhandled text message: {}", room_name, text);
                                            }
                                        },
                                        Message::Pong(_) => {},
                                        Message::Ping(ping_data) => {
                                            if let Err(e) = write.send(Message::Pong(ping_data)).await {
                                                error!("[TASK {}] Failed to send Pong in response to server Ping: {:?}", room_name, e);
                                                break;
                                            }
                                        },
                                        Message::Close(close_frame) => {
                                            warn!("[TASK {}] Received Close frame, triggering disconnect: {:?}", room_name, close_frame);
                                            break;
                                        },
                                        _ => {}
                                    }
                                },
                                Some(Err(e)) => {
                                    error!("[TASK {}] Error reading from WebSocket: {:?}", room_name, e);
                                    break;
                                },
                                None => {
                                    warn!("[TASK {}] WebSocket stream ended.", room_name);
                                    break;
                                }
                            }
                        }
                    }
                }
                warn!("[TASK {}] Loop exited. Disconnected from Binance WebSocket. Reconnecting...", room_name);
            }
            Err(e) => {
                error!("[TASK {}] WebSocket Handshake failed: {:?}. Retrying...", room_name, e);
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}


// --- 辅助函数 & HTTP 处理器 (无变化) ---
fn get_cache_paths(url: &str) -> (PathBuf, PathBuf) {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hash = hasher.finalize();
    let hash_str = hex::encode(hash);
    let cache_dir = Path::new(CACHE_DIR);
    let mut data_path = cache_dir.to_path_buf();
    data_path.push(format!("{}.data", hash_str));
    let mut meta_path = cache_dir.to_path_buf();
    meta_path.push(format!("{}.meta", hash_str));
    (data_path, meta_path)
}
async fn desired_fields_handler() -> AxumJson<Vec<&'static str>> {
    const DESIRED_FIELDS: [&str; 17] = [
        "icon", "symbol", "price", "marketCap", "chain", "chainId", "contractAddress",
        "volume1m", "volume5m", "volume1h", "volume4h", "volume24h",
        "priceChange1m", "priceChange5m", "priceChange1h", "priceChange4h", "priceChange24h",
    ];
    AxumJson(DESIRED_FIELDS.to_vec())
}
async fn image_proxy_handler(Query(query): Query<ImageProxyQuery>) -> Result<Response, StatusCode> {
    let image_url = query.url;
    if Url::parse(&image_url).is_err() {
        warn!("[PROXY WARN] Received invalid URL: {}", image_url);
        return Err(StatusCode::BAD_REQUEST);
    }
    let (data_path, meta_path) = get_cache_paths(&image_url);
    if data_path.exists() && meta_path.exists() {
        if let Ok(meta_json) = fs::read_to_string(&meta_path).await {
            if let Ok(meta) = serde_json::from_str::<CacheMeta>(&meta_json) {
                if let Ok(buffer) = fs::read(&data_path).await {
                    info!("[CACHE HIT] Serving from disk: {}", image_url);
                    let mut headers = HeaderMap::new();
                    headers.insert(
                        http::header::CONTENT_TYPE,
                        HeaderValue::from_str(&meta.content_type)
                            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
                    );
                    headers.insert(
                        http::header::CACHE_CONTROL,
                        HeaderValue::from_static("public, max-age=31536000, immutable"),
                    );
                    return Ok((headers, Bytes::from(buffer)).into_response());
                }
            }
        }
        warn!("[CACHE WARN] Cache files corrupted for {}. Re-fetching...", image_url);
    }
    info!("[CACHE MISS] Fetching via proxy: {}", image_url);
    let proxy = match reqwest::Proxy::all("http://127.0.0.1:1080") {
        Ok(proxy) => proxy,
        Err(e) => {
            error!("[PROXY ERROR] Failed to create proxy: {:?}", e);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/5.37.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| {
            error!("[PROXY ERROR] Failed to build client: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    const MAX_RETRIES: u32 = 10;
    let mut final_result = client.get(&image_url).send().await;
    for attempt in 1..MAX_RETRIES {
        let should_retry = match &final_result {
            Ok(response) => response.status().is_server_error(),
            Err(_) => true,
        };
        if !should_retry { break; }
        match &final_result {
            Ok(response) => warn!("[PROXY RETRY] Attempt {}/{} got server error for {}: {}", attempt, MAX_RETRIES, image_url, response.status()),
            Err(e) => warn!("[PROXY RETRY] Attempt {}/{} connection failed for {}: {:?}", attempt, MAX_RETRIES, image_url, e),
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(300 * attempt as u64)).await;
        final_result = client.get(&image_url).send().await;
    }
    let res = final_result.map_err(|e| {
        error!("[PROXY ERROR] All retries failed for {}: {:?}", image_url, e);
        StatusCode::SERVICE_UNAVAILABLE
    })?;
    if res.status() != reqwest::StatusCode::OK {
        warn!("[PROXY WARN] Upstream fetch failed for {}: {}", image_url, res.status());
        return Err(StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));
    }
    let content_type = res.headers().get(reqwest::header::CONTENT_TYPE).cloned().unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));
    let cache_control = res.headers().get(reqwest::header::CACHE_CONTROL).cloned().unwrap_or_else(|| HeaderValue::from_static("public, max-age=86400"));
    let image_buffer = res.bytes().await.map_err(|e| {
        error!("[PROXY ERROR] Failed to read body from {}: {:?}", image_url, e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;
    let meta = CacheMeta {
        content_type: content_type.to_str().unwrap_or("application/octet-stream").to_string(),
    };
    if let Err(e) = fs::create_dir_all(CACHE_DIR).await {
        error!("[CACHE ERROR] Failed to create cache directory: {:?}", e);
    } else {
        match serde_json::to_string(&meta) {
            Ok(meta_json) => {
                if let Err(e) = fs::write(&data_path, &image_buffer).await { warn!("[CACHE ERROR] Failed to write data file: {:?}", e); }
                if let Err(e) = fs::write(&meta_path, meta_json).await { warn!("[CACHE ERROR] Failed to write meta file: {:?}", e); }
                info!("[CACHE SET] Stored image on disk: {}", image_url);
            }
            Err(e) => { warn!("[CACHE ERROR] Failed to serialize meta data: {:?}", e); }
        }
    }
    let mut headers = HeaderMap::new();
    headers.insert(http::header::CONTENT_TYPE, content_type);
    headers.insert(http::header::CACHE_CONTROL, cache_control);
    headers.insert(http::header::CONTENT_LENGTH, image_buffer.len().into());
    Ok((headers, image_buffer).into_response())
}

// --- 主函数 (无变化) ---
#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "backend=info,tower_http=info".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cors = CorsLayer::new()
        .allow_origin("http://localhost:15173".parse::<HeaderValue>().expect("Invalid CORS origin"))
        .allow_methods(Any)
        .allow_headers(Any);

    let (layer, io) = SocketIo::new_layer();

    let io_clone_for_ns = io.clone();
    io.ns("/", move |s: SocketRef| async move {
        on_socket_connect(s, io_clone_for_ns.clone()).await;
    });

    let app = Router::new()
        .route("/desired-fields", get(desired_fields_handler))
        .route("/image-proxy", get(image_proxy_handler))
        .layer(cors)
        .layer(layer);

    info!("🚀 Rust server is running at http://0.0.0.0:3001");
    info!("Waiting for clients to connect...");

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001").await.expect("Failed to bind to port 3001");
    axum::serve(listener, app).await.expect("Server failed to start");
}