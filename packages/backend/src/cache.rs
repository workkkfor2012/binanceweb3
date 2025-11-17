// packages/backend/src/cache.rs
use super::{config::Config, error::AppError, types::CacheMeta};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs;
use tracing::{info, warn};

/// 基于 URL 哈希生成缓存文件路径。
fn get_cache_paths(url: &str, config: &Config) -> (PathBuf, PathBuf) {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hash = hasher.finalize();
    let hash_str = hex::encode(hash);

    let cache_dir = Path::new(&config.cache_dir);
    let data_path = cache_dir.join(format!("{}.data", hash_str));
    let meta_path = cache_dir.join(format!("{}.meta", hash_str));
    (data_path, meta_path)
}

/// 尝试从缓存中获取响应。
pub async fn get_cached_response(
    url: &str,
    config: &Config,
) -> Result<Option<Response>, AppError> {
    let (data_path, meta_path) = get_cache_paths(url, config);
    if !data_path.exists() || !meta_path.exists() {
        return Ok(None);
    }

    let meta_json = fs::read_to_string(&meta_path).await?;
    let meta: CacheMeta = serde_json::from_str(&meta_json)?;
    let buffer = fs::read(&data_path).await?;

    // --- LRU 逻辑：更新访问时间 ---
    // 异步执行，不阻塞当前请求的响应
    let meta_path_clone = meta_path.clone();
    tokio::spawn(async move {
        // 通过重写元数据文件来更新它的 mtime
        if let Err(e) = fs::write(meta_path_clone, meta_json).await {
            warn!("[CACHE TOUCH] Failed to update metadata timestamp: {}", e);
        }
    });
    // --- 结束 ---

    info!("[CACHE HIT] Serving from disk: {}", url);
    let mut headers = HeaderMap::new();
    headers.insert(
        http::header::CONTENT_TYPE,
        HeaderValue::from_str(&meta.content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        http::header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Ok(Some((headers, Bytes::from(buffer)).into_response()))
}

/// 将响应数据保存到缓存。
pub async fn save_to_cache(
    url: &str,
    content_type: &HeaderValue,
    data: &Bytes,
    config: &Config,
) -> Result<(), AppError> {
    let (data_path, meta_path) = get_cache_paths(url, config);
    // 确保缓存目录存在
    if let Some(parent) = data_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    
    let meta = CacheMeta {
        content_type: content_type
            .to_str()
            .unwrap_or("application/octet-stream")
            .to_string(),
    };

    let meta_json = serde_json::to_string(&meta)?;
    fs::write(&data_path, data).await?;
    fs::write(&meta_path, meta_json).await?;

    info!("[CACHE SET] Stored on disk: {}", url);
    Ok(())
}
