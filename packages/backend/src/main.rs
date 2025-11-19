// packages/backend/src/main.rs

mod binance_task;
mod cache;
mod cache_manager;
mod client_pool; // ✨ 注册新模块
mod config;
mod error;
mod http_handlers;
mod kline_handler;
mod socket_handlers;
mod state;
mod types;

use axum::{routing::get, Router};
use client_pool::ClientPool; // ✨ 引入
use config::Config;
use dashmap::DashMap;
use http::HeaderValue;
use socketioxide::{extract::SocketRef, SocketIo};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct ServerState {
    pub app_state: state::AppState,
    pub config: Arc<Config>,
    pub io: SocketIo,
    pub token_symbols: Arc<DashMap<String, String>>,
    pub db_pool: SqlitePool,
    pub client_pool: ClientPool, // ✨ 替换 http_client 为 client_pool
}

#[tokio::main]
async fn main() {
    init_tracing();

    let (layer, io) = SocketIo::builder().max_buffer_size(40960).build_layer();

    let config = Arc::new(Config::new());

    if let Some(parent) = std::path::Path::new(&config.database_url.replace("sqlite:", "")).parent()
    {
        if !parent.exists() {
            std::fs::create_dir_all(parent).expect("Failed to create database directory");
        }
    }

    let db_pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .expect("Failed to connect to SQLite database");
    info!("🗃️ Database connection pool established.");

    kline_handler::init_db(&db_pool)
        .await
        .expect("Failed to initialize database schema");

    // ✨ 初始化连接池：20个并发连接
    // 注意：这里使用了 config.proxy_addr，请确保你的 config.rs 里 proxy_addr 是完整的 (如 http://127.0.0.1:7890)
    // 如果 config.proxy_addr 只是 ip:port，你需要在这里加 "http://" 前缀
    let proxy_url = if config.proxy_addr.starts_with("http") || config.proxy_addr.starts_with("socks") {
        config.proxy_addr.clone()
    } else {
        format!("http://{}", config.proxy_addr)
    };
    
    info!("🏊 Initializing Client Pool with 20 connections via {}...", proxy_url);
    let client_pool = ClientPool::new(20, proxy_url).await;

    let server_state = ServerState {
        app_state: state::new_app_state(),
        config: config.clone(),
        io: io.clone(),
        token_symbols: Arc::new(DashMap::new()),
        db_pool,
        client_pool, // ✨ 注入池
    };

    let socket_state = server_state.clone();
    io.ns("/", move |s: SocketRef| {
        let state = socket_state.clone();
        async move {
            socket_handlers::on_socket_connect(s, state).await;
        }
    });

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
                .unwrap_or_else(|_| "backend=info,tower_http=info,sqlx=warn".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}