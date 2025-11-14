// packages/backend/src/main.rs
use axum::{
    // ✨ 移除 'State'，因为我们不再使用共享内存缓存
    extract::Query,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json as AxumJson, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use hex; // ✨ 导入 hex
use serde::{Deserialize, Serialize}; // ✨ 导入 Serialize
use sha2::{Digest, Sha256}; // ✨ 导入 sha2
use socketioxide::{
    extract::{Data, SocketRef},
    SocketIo,
};
// ✨ 导入: std::path, tokio::fs
use std::path::{Path, PathBuf};
use tokio::fs;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use url::Url;

// --- 常量 ---
/// 定义磁盘缓存目录
const CACHE_DIR: &str = "./image_cache";

// --- 类型定义 ---

/// 图像代理的查询参数
#[derive(Debug, Deserialize)]
struct ImageProxyQuery {
    url: String,
}

/// ✨ 新增: 存储在 .meta 文件中的元数据结构
#[derive(Serialize, Deserialize)]
struct CacheMeta {
    content_type: String,
}

// --- Socket.IO 处理器 ---

/// 当一个新的 Socket.IO 客户端连接时调用
/// 我们将 `io` 句柄移入闭包中，以便 `data-update` 处理器可以访问它
async fn on_socket_connect(socket: SocketRef, io: SocketIo) {
    // 'sid' 字段已重命名为 'id'
    info!("🔌 [Socket.IO] Client connected: {}", socket.id);

    // 监听来自 extractor 的 'data-update' 事件
    socket.on(
        "data-update",
        // 'on' 处理器现在必须是 'async'
        // 'payload' 提取器应为 'Data<serde_json::Value>'
        move |socket: SocketRef, payload: Data<serde_json::Value>| async move {
            info!(
                "[Socket.IO] Received 'data-update' from {}. Broadcasting 'data-broadcast'...",
                // 'sid' 字段已重命名为 'id'
                socket.id
            );

            // 将数据广播给所有连接的客户端（包括发送者）
            // 'emit' 现在是 'async' (需要 .await)
            // 'Data<T>' 也使用 '.0' 访问内部数据
            if let Err(e) = io.emit("data-broadcast", &payload.0).await {
                error!("[Socket.IO] Failed to broadcast data: {:?}", e);
            }
        },
    );

    // 'on_disconnect' 处理器现在也必须是 'async'
    socket.on_disconnect(move |socket: SocketRef| async move {
        // 'sid' 字段已重命名为 'id'
        info!("[Socket.IO] Client disconnected: {}", socket.id);
    });
}

// --- 辅助函数 ---

/// ✨ 新增: 根据 URL 生成缓存文件的路径
/// 返回 (.data 路径, .meta 路径)
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

// --- HTTP 路由处理器 ---

/// `/desired-fields` 路由
/// 返回 `shared-types` 中的硬编码字段列表
async fn desired_fields_handler() -> AxumJson<Vec<&'static str>> { // 使用 AxumJson
    const DESIRED_FIELDS: [&str; 17] = [
        "icon",
        "symbol",
        "price",
        "marketCap",
        "chain",
        "chainId",
        "contractAddress",
        "volume1m",
        "volume5m",
        "volume1h",
        "volume4h",
        "volume24h",
        "priceChange1m",
        "priceChange5m",
        "priceChange1h",
        "priceChange4h",
        "priceChange24h",
    ];
    AxumJson(DESIRED_FIELDS.to_vec()) // 使用 AxumJson
}

/// `/image-proxy` 路由
/// ✨ 重构: 通过代理获取图片，并使用磁盘缓存
async fn image_proxy_handler(
    Query(query): Query<ImageProxyQuery>,
    // ✨ 移除 State(state): State<AppState>
) -> Result<Response, StatusCode> {
    let image_url = query.url;

    // 验证 URL
    if Url::parse(&image_url).is_err() {
        warn!("[PROXY WARN] Received invalid URL: {}", image_url);
        return Err(StatusCode::BAD_REQUEST);
    }

    // 1. ✨ 检查磁盘缓存
    let (data_path, meta_path) = get_cache_paths(&image_url);

    if data_path.exists() && meta_path.exists() {
        // 尝试读取元数据和数据文件
        // 如果任何步骤失败（例如文件损坏），我们会将错误记录为警告并继续执行缓存未命中逻辑
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
                    // 因为我们知道这些是永久的，所以给一个很长的缓存时间
                    headers.insert(
                        http::header::CACHE_CONTROL,
                        HeaderValue::from_static("public, max-age=31536000, immutable"),
                    );
                    return Ok((headers, Bytes::from(buffer)).into_response());
                }
            }
        }
        // 如果我们到了这里，说明缓存文件已损坏或不可读
        warn!(
            "[CACHE WARN] Cache files corrupted for {}. Re-fetching...",
            image_url
        );
    }

    info!("[CACHE MISS] Fetching via proxy: {}", image_url);

    // 2. 设置 HTTP 代理
    // ✨ 修复: 将 "socks5://" 更改为 "http://" 以匹配 TypeScript 版本
    let proxy = match reqwest::Proxy::all("http://127.0.0.1:1080") {
        Ok(proxy) => proxy,
        Err(e) => {
            error!("[PROXY ERROR] Failed to create proxy: {:?}", e);
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    // 3. 创建 Reqwest 客户端
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/5.37.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/5.37.36")
        .build()
        .map_err(|e| {
            error!("[PROXY ERROR] Failed to build client: {:?}", e);
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    // 4. 发起请求 (重试逻辑)
    const MAX_RETRIES: u32 = 10;
    
    let mut final_result = client.get(&image_url).send().await;

    for attempt in 1..MAX_RETRIES {
        let should_retry = match &final_result {
            Ok(response) => response.status().is_server_error(), // 只重试 5xx 服务器错误
            Err(_) => true, // 重试连接错误
        };

        if !should_retry {
            break;
        }

        match &final_result {
            Ok(response) => warn!(
                "[PROXY RETRY] Attempt {}/{} got server error for {}: {}",
                attempt, MAX_RETRIES, image_url, response.status()
            ),
            Err(e) => warn!(
                "[PROXY RETRY] Attempt {}/{} connection failed for {}: {:?}",
                attempt, MAX_RETRIES, image_url, e
            ),
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(300 * attempt as u64)).await;
        final_result = client.get(&image_url).send().await;
    }

    let res = final_result.map_err(|e| {
        error!("[PROXY ERROR] All retries failed for {}: {:?}", image_url, e);
        StatusCode::SERVICE_UNAVAILABLE
    })?;

    // 5. 检查最终的状态码
    if res.status() != reqwest::StatusCode::OK {
        warn!(
            "[PROXY WARN] Upstream fetch failed for {}: {}",
            image_url,
            res.status()
        );
        return Err(StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY));
    }

    // 6. 处理响应头
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));

    let cache_control = res
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("public, max-age=86400"));

    // 7. 读取响应体
    let image_buffer = res.bytes().await.map_err(|e| {
        error!("[PROXY ERROR] Failed to read body from {}: {:?}", image_url, e);
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // 8. ✨ 存入磁盘缓存
    let meta = CacheMeta {
        content_type: content_type
            .to_str()
            .unwrap_or("application/octet-stream")
            .to_string(),
    };

    // 确保缓存目录存在
    if let Err(e) = fs::create_dir_all(CACHE_DIR).await {
        error!("[CACHE ERROR] Failed to create cache directory: {:?}", e);
    } else {
        // 序列化元数据
        match serde_json::to_string(&meta) {
            Ok(meta_json) => {
                // 异步写入 .data 和 .meta 文件
                if let Err(e) = fs::write(&data_path, &image_buffer).await {
                    warn!("[CACHE ERROR] Failed to write data file: {:?}", e);
                }
                if let Err(e) = fs::write(&meta_path, meta_json).await {
                    warn!("[CACHE ERROR] Failed to write meta file: {:?}", e);
                }
                info!("[CACHE SET] Stored image on disk: {}", image_url);
            }
            Err(e) => {
                warn!("[CACHE ERROR] Failed to serialize meta data: {:?}", e);
            }
        }
    }

    // 9. 返回响应
    let mut headers = HeaderMap::new();
    headers.insert(http::header::CONTENT_TYPE, content_type);
    headers.insert(http::header::CACHE_CONTROL, cache_control);
    headers.insert(http::header::CONTENT_LENGTH, image_buffer.len().into());

    Ok((headers, image_buffer).into_response())
}

// --- 主函数 ---

#[tokio::main]
async fn main() {
    // 初始化日志
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // CORS 中间件
    let cors = CorsLayer::new()
        .allow_origin(
            "http://localhost:15173"
                .parse::<HeaderValue>()
                .expect("Invalid CORS origin"),
        )
        .allow_methods(Any)
        .allow_headers(Any);

    // Socket.IO 层和 `io` 句柄
    let (layer, io) = SocketIo::new_layer();

    // 关键：克隆 `io` 句柄并将其 `move` 到连接处理器中
    let io_for_ns = io.clone();
    io.ns("/", move |socket| on_socket_connect(socket, io_for_ns.clone()));

    // ✨ 移除 AppState
    // Axum 路由
    let app = Router::new()
        .route("/desired-fields", get(desired_fields_handler))
        .route("/image-proxy", get(image_proxy_handler))
        // ✨ 移除 .with_state(state)
        .layer(cors)   // 应用 CORS
        .layer(layer); // 应用 Socket.IO

    info!("🚀 Rust server is running at http://0.0.0.0:3001");
    info!("Waiting for clients to connect...");

    // 启动服务器
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001")
        .await
        .expect("Failed to bind to port 3001");
    
    axum::serve(listener, app)
        .await
        .expect("Server failed to start");
}