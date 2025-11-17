// packages/backend/src/http_handlers.rs
use super::{cache, config::Config, error::AppError, types::ImageProxyQuery, ServerState};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Json as AxumJson, Response},
};
use http::HeaderValue;
use reqwest;
// 修正：移除了未使用的 Arc 导入
use tracing::{info, warn};
use url::Url;

/// 处理监控字段配置的请求。
pub async fn desired_fields_handler(State(state): State<ServerState>) -> AxumJson<Vec<&'static str>> {
    AxumJson(state.config.desired_fields.clone())
}

/// 处理图片代理请求，包含缓存逻辑。
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

    // 3. 如果缓存未命中，则从源站抓取
    info!("[CACHE MISS] Fetching via proxy: {}", image_url);
    let client = build_proxy_client(&config)?;
    let res = client.get(&image_url).send().await?;

    if res.status() != reqwest::StatusCode::OK {
        return Err(AppError::UpstreamError(res.status()));
    }

    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"));

    let image_buffer = res
        .bytes()
        .await
        .map_err(|e| AppError::BodyReadError(e.to_string()))?;

    // 4. 异步保存到缓存
    let cache_config = config.clone();
    let cache_image_url = image_url.clone();
    let cache_content_type = content_type.clone();
    let cache_image_buffer = image_buffer.clone();
    tokio::spawn(async move {
        if let Err(e) =
            cache::save_to_cache(&cache_image_url, &cache_content_type, &cache_image_buffer, &cache_config).await
        {
            warn!("[CACHE ASYNC] Failed to save to cache: {}", e);
        }
    });

    // 5. 返回响应给客户端
    let mut headers = HeaderMap::new();
    headers.insert(http::header::CONTENT_TYPE, content_type);
    headers.insert(
        http::header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    headers.insert(http::header::CONTENT_LENGTH, image_buffer.len().into());

    Ok((headers, image_buffer).into_response())
}

// --- 辅助函数 ---

fn build_proxy_client(config: &Config) -> Result<reqwest::Client, AppError> {
    let proxy_url = format!("http://{}", config.proxy_addr);
    let proxy = reqwest::Proxy::all(&proxy_url)
        .map_err(|e| AppError::ProxyClientBuild(e.to_string()))?;

    reqwest::Client::builder()
        .proxy(proxy)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/5.37.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/5.37.36")
        .build()
        .map_err(|e| AppError::ProxyClientBuild(e.to_string()))
}