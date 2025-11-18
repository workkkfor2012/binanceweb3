// packages/backend/src/main.rs
mod binance_task;
mod cache;
mod config;
mod error;
mod http_handlers;
mod socket_handlers;
mod state;
mod types;
mod cache_manager;

use axum::{routing::get, Router};
use config::Config;
use http::HeaderValue;
use socketioxide::{extract::SocketRef, SocketIo};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct ServerState {
    pub app_state: state::AppState,
    pub config: Arc<Config>,
    pub io: SocketIo,
}

#[tokio::main]
async fn main() {
    init_tracing();

    // --- 核心修改：使用 SocketIo::builder() 来增大缓冲区 ---
    let (layer, io) = SocketIo::builder()
        // 默认值是 128，我们将其扩大 32 倍以吸收重启时的数据洪峰
        // 这意味着在报错前，可以为每个 socket 缓存 4096 条待发送的消息
        .max_buffer_size(40960) 
        .build_layer();
    // --- 修改结束 ---
    
    let config = Arc::new(Config::new());

    let server_state = ServerState {
        app_state: state::new_app_state(),
        config: config.clone(),
        io: io.clone(),
    };

    let socket_state = server_state.clone();
    io.ns(
        "/",
        move |s: SocketRef| {
            let state = socket_state.clone();
            async move {
                socket_handlers::on_socket_connect(s, state).await;
            }
        },
    );

    tokio::spawn(cache_manager::cache_manager_task(config));

    let app = Router::new()
        .route(
            "/desired-fields",
            get(http_handlers::desired_fields_handler),
        )
        .route("/image-proxy", get(http_handlers::image_proxy_handler))
        .with_state(server_state)
        .layer(
            CorsLayer::new()
                .allow_origin(
                    "http://localhost:15173"
                        .parse::<HeaderValue>()
                        .expect("Invalid CORS origin"),
                )
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(layer);

    info!("🚀 Rust server is running at http://0.0.0.0:3001");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001")
        .await
        .expect("Failed to bind to port 3001");
    axum::serve(listener, app)
        .await
        .expect("Server failed to start");
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}