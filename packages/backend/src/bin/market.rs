// packages/backend/src/bin/market.rs
use backend::{init_tracing, setup_shared_state, socket_handlers};
use axum::Router;
use socketioxide::SocketIo;
use std::sync::Arc;
use tracing::info;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() {
    init_tracing();
    info!("📊 Starting Backend Market (Local Mode)");

    let (layer, io) = SocketIo::builder().max_buffer_size(40960).build_layer();
    let config = Arc::new(backend::config::Config::new());
    let server_state = setup_shared_state(config.clone(), io.clone()).await;

    let socket_state = server_state.clone();
    io.ns("/", move |s: socketioxide::extract::SocketRef| {
        let state = socket_state.clone();
        async move {
            // Market 模式主要处理 K 线订阅和历史请求
            socket_handlers::on_socket_connect(s, state).await;
        }
    });

    let app = Router::new()
        .with_state(server_state)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(layer);

    // 本地不一定需要 HTTPS，直接监听 30003
    let port = 30003;
    info!("📊 Market server listening on port {}", port);
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
