// packages/backend/src/error.rs
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use thiserror::Error;

// 定义我们应用的主要错误类型，专门用于HTTP处理层
#[derive(Debug, Error)]
pub enum AppError {
    #[error("Reqwest error: {0}")]
    Reqwest(#[from] reqwest::Error),

    #[error("Invalid URL: {0}")]
    InvalidUrl(String),

    #[error("Failed to parse URL: {0}")]
    UrlParse(#[from] url::ParseError),

    #[error("Upstream server returned an error: {0}")]
    UpstreamError(StatusCode),

    #[error("Failed to read response body: {0}")]
    BodyReadError(String),

    #[error("Cache I/O error: {0}")]
    CacheIO(#[from] std::io::Error),

    #[error("Cache metadata serialization failed: {0}")]
    CacheMetaSerialization(#[from] serde_json::Error),

    #[error("Failed to create proxy client: {0}")]
    ProxyClientBuild(String),
}

// 实现 IntoResponse trait，这样我们的错误类型可以直接在 Axum handler 中返回
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // 在服务端记录完整的错误细节
        tracing::error!("HTTP Handler Error: {}", self);

        let (status, error_message) = match self {
            AppError::InvalidUrl(url) => (StatusCode::BAD_REQUEST, format!("Invalid URL: {}", url)),
            AppError::UrlParse(_) => (StatusCode::BAD_REQUEST, "Failed to parse URL".to_string()),
            AppError::UpstreamError(code) => (code, format!("Upstream server error: {}", code)),
            // 其他错误都归为内部服务器错误，避免向客户端暴露过多细节
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "An internal error occurred".to_string(),
            ),
        };

        (status, error_message).into_response()
    }
}