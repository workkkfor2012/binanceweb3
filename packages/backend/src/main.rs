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
mod token_manager; // ✨ 新增模块
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
use std::fs::File;
use std::io::BufReader;
use rustls::ServerConfig;

// ✨ 引入新类型
use crate::state::{TokenManagerMap, SubscriptionCommand}; // 修改引用

#[derive(Clone)]
pub struct ServerState {
    pub app_state: state::AppState,
    pub room_index: state::RoomIndex,
    pub config: Arc<Config>,
    pub io: SocketIo,
    pub token_symbols: Arc<DashMap<String, String>>,
    pub narrative_cache: state::NarrativeCache,
    pub db_pool: SqlitePool,
    pub client_pool: ClientPool,
    pub narrative_proxy_pool: ClientPool,
    pub image_proxy_pool: ClientPool,
    pub token_managers: TokenManagerMap, // ✨ 替换为 Token Managers
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

    let app_state = state::new_app_state();
    let room_index = state::new_room_index();
    let token_managers = state::new_token_manager_map();

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
        image_proxy_pool,
        token_managers,
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

    // 🔐 HTTPS 配置（HTTP/2 支持 - 使用 Ring 加密后端）
    let cert_file = File::open("cert.pem")
        .expect("Failed to open cert.pem");
    let key_file = File::open("key.pem")
        .expect("Failed to open key.pem");
    
    let mut cert_reader = BufReader::new(cert_file);
    let mut key_reader = BufReader::new(key_file);
    
    let certs = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .expect("Failed to parse cert.pem");
    
    let key = rustls_pemfile::private_key(&mut key_reader)
        .expect("Failed to read private key")
        .expect("No private key found in key.pem");
    
    let mut tls_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .expect("Failed to build TLS config");
    
    // 启用 HTTP/2
    tls_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    
    let rustls_config = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls_config));

    // 🚀 启动两个服务器（并发运行）
    info!("🔒 Starting HTTPS server on port 3001 (HTTP/2 for frontend)");
    info!("🌐 Starting HTTP server on port 3002 (HTTP/1.1 for crawler)");
    
    let https_app = app.clone();
    let http_app = app;
    
    let https_server = tokio::spawn(async move {
        axum_server::bind_rustls("0.0.0.0:3001".parse::<std::net::SocketAddr>().unwrap(), rustls_config)
            .serve(https_app.into_make_service())
            .await
            .unwrap();
    });
    
    let http_server = tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind("0.0.0.0:3002").await.unwrap();
        axum::serve(listener, http_app).await.unwrap();
    });
    
    // 等待两个服务器（任意一个崩溃就退出）
    tokio::select! {
        _ = https_server => info!("HTTPS server stopped"),
        _ = http_server => info!("HTTP server stopped"),
    }
}

fn init_tracing() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "backend=info,tower_http=info,sqlx=warn".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();
}