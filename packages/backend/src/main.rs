// packages/backend/src/main.rs
mod binance_task;
mod cache;
mod config;
mod error;
mod http_handlers;
mod socket_handlers;
mod state;
mod types;
mod cache_manager; // 1. 声明新模块

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

    let (layer, io) = SocketIo::new_layer();
    let config = Arc::new(Config::new());

    let server_state = ServerState {
        app_state: state::new_app_state(),
        config: config.clone(), // 2. 克隆 Arc<Config> 给 server_state
        io: io.clone(),
    };

    // 核心修正：为 move 闭包创建一个 state 的克隆
    let socket_state = server_state.clone();
    io.ns(
        "/",
        // 这个 move 闭包现在捕获的是 `socket_state`，而不是 `server_state`
        move |s: SocketRef| {
            // 在 async 块内部，我们克隆的是被捕获的 `socket_state`
            let state = socket_state.clone();
            async move {
                socket_handlers::on_socket_connect(s, state).await;
            }
        },
    );

    // 3. 启动缓存管理后台任务
    // 我们将最初的 Arc<Config> 移动到任务中
    tokio::spawn(cache_manager::cache_manager_task(config));

    let app = Router::new()
        .route(
            "/desired-fields",
            get(http_handlers::desired_fields_handler),
        )
        .route("/image-proxy", get(http_handlers::image_proxy_handler))
        // 这里我们使用原始的 `server_state`，它的所有权被移动到 Axum 的 state layer 中
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