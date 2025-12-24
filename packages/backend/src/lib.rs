// packages/backend/src/lib.rs
pub mod binance_task;
pub mod cache;
pub mod cache_manager;
pub mod client_pool;
pub mod config;
pub mod error;
pub mod http_handlers;
pub mod kline_handler;
pub mod socket_handlers;
pub mod state;
pub mod token_manager;
pub mod types;
pub mod alert_handler;

use client_pool::ClientPool;
use config::Config;
use dashmap::DashMap;
use socketioxide::SocketIo;
use sqlx::SqlitePool;
use std::sync::Arc;
use std::collections::VecDeque;
use tokio::sync::Mutex;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

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
    pub token_managers: state::TokenManagerMap,
    /// 报警历史队列 (最多保留 50 条，后进先出)
    pub alert_history: Arc<Mutex<VecDeque<types::AlertLogEntry>>>,
    /// 报警冷却映射
    pub alert_cooldowns: Arc<DashMap<String, i64>>,
}

pub fn init_tracing() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "backend=info,tower_http=info,sqlx=warn".into()))
        .with(tracing_subscriber::fmt::layer())
        .init();
}

pub async fn setup_shared_state(config: Arc<Config>, io: SocketIo) -> ServerState {
    // Database Setup
    if let Some(parent) = std::path::Path::new(&config.database_url.replace("sqlite:", "")).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).expect("Failed to create database directory");
        }
    }

    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous, SqlitePoolOptions};
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
    let client_pool = ClientPool::new(20, None, "DIRECT".to_string()).await;
    let proxy_url = format!("http://{}", config.proxy_addr);
    let narrative_proxy_pool = ClientPool::new(10, Some(proxy_url.clone()), "PROXY_API".to_string()).await;
    let image_proxy_pool = ClientPool::new(10, Some(proxy_url), "PROXY_IMG".to_string()).await;

    let app_state = state::new_app_state();
    let room_index = state::new_room_index();
    let token_managers = state::new_token_manager_map();
    let alert_history = Arc::new(Mutex::new(VecDeque::with_capacity(50)));
    let alert_cooldowns = Arc::new(DashMap::new());

    ServerState {
        app_state,
        room_index,
        config,
        io,
        token_symbols: Arc::new(DashMap::new()),
        narrative_cache: state::new_narrative_cache(),
        db_pool,
        client_pool,
        narrative_proxy_pool,
        image_proxy_pool,
        token_managers,
        alert_history,
        alert_cooldowns,
    }
}
