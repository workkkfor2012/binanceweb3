// packages/backend/src/main.rs
mod binance_task;
mod cache;
mod cache_manager;
mod client_pool;
mod config;
mod error;
mod http_handlers;
mod kline_handler;
mod socket_handlers;
mod state;
mod types;

use axum::{routing::get, Router};
use client_pool::ClientPool;
use config::Config;
use dashmap::DashMap;
use http::HeaderValue;
use socketioxide::{extract::SocketRef, SocketIo};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use std::sync::Arc;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

// ✨ 引入新类型
use crate::state::{BinanceChannels, SubscriptionCommand};

#[derive(Clone)]
pub struct ServerState {
    pub app_state: state::AppState,
    pub room_index: state::RoomIndex, // ✨ 索引
    pub config: Arc<Config>,
    pub io: SocketIo,
    pub token_symbols: Arc<DashMap<String, String>>,
    pub narrative_cache: state::NarrativeCache,
    pub db_pool: SqlitePool,
    pub client_pool: ClientPool,
    pub narrative_proxy_pool: ClientPool,
    pub image_proxy_pool: ClientPool, // ✨ 新增：专门用于图片的代理池
    pub binance_channels: BinanceChannels, // ✨ 通道
}

#[tokio::main]
async fn main() {
    init_tracing();

    let (layer, io) = SocketIo::builder().max_buffer_size(40960).build_layer();
    let config = Arc::new(Config::new());

    // Database Setup
    if let Some(parent) = std::path::Path::new(&config.database_url.replace("sqlite:", "")).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).expect("Failed to create database directory");
        }
    }

    // ✨ 优化 DB 配置：开启 WAL 模式，提升并发读写性能
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
    use std::str::FromStr;

    let db_opts = SqliteConnectOptions::from_str(&config.database_url)
        .expect("Invalid database URL")
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);

    let db_pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(db_opts)
        .await
        .expect("Failed to connect to SQLite database");
    kline_handler::init_db(&db_pool).await.expect("Failed to initialize database schema");

    // Pools
    info!("🚀 Initializing Direct Client Pool...");
    let client_pool = ClientPool::new(20, None, "DIRECT".to_string()).await;

    info!("🌐 Initializing Proxy Client Pools...");
    let proxy_url = format!("http://{}", config.proxy_addr);

    // 叙事抓取池 (API 请求，较低并发)
    let narrative_proxy_pool = ClientPool::new(10, Some(proxy_url.clone()), "PROXY_API".to_string()).await;

    // ✨ 图片代理池 (高并发，大流量)
    // 增加连接数以应对并发加载图片的场景，使用独立的池避免阻塞 API 请求
    let image_proxy_pool = ClientPool::new(10, Some(proxy_url), "PROXY_IMG".to_string()).await;

    // ✨ 1. 创建全局 Channels
    let (kline_tx, kline_rx) = mpsc::unbounded_channel::<SubscriptionCommand>();
    let (tick_tx, tick_rx) = mpsc::unbounded_channel::<SubscriptionCommand>();

    let app_state = state::new_app_state();
    let room_index = state::new_room_index();

    // ✨ 2. 启动全局 Binance 任务
    // Task A: Kline Manager (不需要索引)
    let config_clone1 = config.clone();
    let io_clone1 = io.clone();
    let state_clone1 = app_state.clone();
    tokio::spawn(async move {
        binance_task::start_global_manager(
            binance_task::TaskType::Kline,
            io_clone1,
            config_clone1,
            state_clone1,
            None, 
            kline_rx,
        ).await;
    });

    // Task B: Tick Manager (需要索引)
    let config_clone2 = config.clone();
    let io_clone2 = io.clone();
    let state_clone2 = app_state.clone();
    let index_clone2 = room_index.clone();
    tokio::spawn(async move {
        binance_task::start_global_manager(
            binance_task::TaskType::Tick,
            io_clone2,
            config_clone2,
            state_clone2,
            Some(index_clone2),
            tick_rx,
        ).await;
    });

    let server_state = ServerState {
        app_state,
        room_index,
        config: config.clone(),
        io: io.clone(),
        token_symbols: Arc::new(DashMap::new()),
        narrative_cache: state::new_narrative_cache(),
        db_pool,
        client_pool,
        narrative_proxy_pool,
        image_proxy_pool, // 注入图片池
        binance_channels: BinanceChannels { kline_tx, tick_tx },
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
        .route("/desired-fields", get(http_handlers::desired_fields_handler))
        .route("/image-proxy", get(http_handlers::image_proxy_handler))
        .with_state(server_state)
        .layer(
            CorsLayer::new()
                .allow_origin("http://localhost:15173".parse::<HeaderValue>().unwrap())
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(layer);

    info!("🚀 Rust server is running at http://0.0.0.0:3001");
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3001").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "backend=info,tower_http=info,sqlx=warn".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();
}