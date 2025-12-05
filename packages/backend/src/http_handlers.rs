// packages/backend/src/http_handlers.rs
use super::{cache, error::AppError, types::ImageProxyQuery, ServerState};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Json as AxumJson, Response},
};
use http::HeaderValue;
use reqwest;
use tracing::{warn, error};
use url::Url;

/// 处理监控字段配置的请求。
pub async fn desired_fields_handler(State(state): State<ServerState>) -> AxumJson<Vec<&'static str>> {
    AxumJson(state.config.desired_fields.clone())
}

/// 处理图片代理请求，包含缓存逻辑。
/// 
/// 优化：使用了连接池 (Connection Pool) 和重试机制，
/// 避免了频繁建立 TCP/TLS 连接的开销，并能自动剔除失效的代理节点。
pub async fn image_proxy_handler(
    State(state): State<ServerState>,
    Query(query): Query<ImageProxyQuery>,
) -> Result<Response, AppError> {
    let config = state.config;
    let image_url = query.url;

    // 1. 验证 URL
    Url::parse(&image_url).map_err(|_| AppError::InvalidUrl(image_url.clone()))?;

    // 2. 检查缓存
    if let Some(cached_response) = cache::get_cached_response(&image_url, &config).await? {
        return Ok(cached_response);
    }

    // 3. 如果缓存未命中，则从源站抓取 (使用连接池 + 重试逻辑)
    // 最多重试 2 次
    let mut response_bytes = None;
    let mut response_content_type = HeaderValue::from_static("application/octet-stream");
    let mut last_error_status = reqwest::StatusCode::INTERNAL_SERVER_ERROR;

    for attempt in 1..=10 {
        // 从连接池获取 Client 和 索引
        let (client_idx, client) = state.image_proxy_pool.get_client().await;
        
        match client.get(&image_url).send().await {
            Ok(res) => {
                if res.status().is_success() {
                    response_content_type = res
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .cloned()
                        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));
                    
                    match res.bytes().await {
                        Ok(bytes) => {
                            response_bytes = Some(bytes);
                            break; // 成功获取，退出重试循环
                        },
                        Err(e) => {
                            warn!("❌ [IMG PROXY] Read body failed: {}. Retrying...", e);
                             // 读取 body 失败，连接可能断了，回收连接
                            state.image_proxy_pool.recycle_client(client_idx).await;
                        }
                    }
                } else {
                    last_error_status = res.status();
                    // 策略：5xx 错误可能是代理节点问题，需要回收；404 可能是源站问题，不回收但记录警告
                    if res.status().as_u16() >= 500 {
                        state.image_proxy_pool.recycle_client(client_idx).await;
                    }
                    warn!("⚠️ [IMG PROXY] Upstream {}: {}. Attempt {}/2", res.status(), image_url, attempt);
                }
            },
            Err(e) => {
                // 连接层面的错误（如超时、握手失败），必须回收连接
                warn!("❌ [IMG PROXY] Request failed: {}. Recycling client #{}. Attempt {}/2", e, client_idx, attempt);
                state.image_proxy_pool.recycle_client(client_idx).await;
            }
        }
    }

    // 4. 处理结果
    match response_bytes {
        Some(image_buffer) => {
            // 异步保存到缓存，避免阻塞响应
            let cache_config = config.clone();
            let cache_image_url = image_url.clone();
            let cache_content_type = response_content_type.clone();
            let cache_image_buffer = image_buffer.clone();
            
            tokio::spawn(async move {
                if let Err(e) =
                    cache::save_to_cache(&cache_image_url, &cache_content_type, &cache_image_buffer, &cache_config).await
                {
                    warn!("[CACHE ASYNC] Failed to save to cache: {}", e);
                }
            });

            // 返回响应
            let mut headers = HeaderMap::new();
            headers.insert(http::header::CONTENT_TYPE, response_content_type);
            headers.insert(
                http::header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=86400"),
            );
            headers.insert(http::header::CONTENT_LENGTH, image_buffer.len().into());

            Ok((headers, image_buffer).into_response())
        },
        None => {
            error!("🔥 [IMG PROXY] Failed to fetch image after retries: {}. Last Status: {}", image_url, last_error_status);
            Err(AppError::UpstreamError(last_error_status))
        }
    }
}