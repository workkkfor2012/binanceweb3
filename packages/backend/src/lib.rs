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
    /// ✨ 全局黑名单 (合约地址)
    pub blacklist: Arc<dashmap::DashSet<String>>,
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
        .synchronous(SqliteSynchronous::Normal)
        .pragma("cache_size", "-50000")
        .pragma("mmap_size", "104857600")
        .pragma("busy_timeout", "5000");

    let db_pool = SqlitePoolOptions::new()
        .max_connections(50)
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
    let blacklist = Arc::new(dashmap::DashSet::new());

    // ✨ 加载初始黑名单
    if let Ok(list) = kline_handler::get_blacklist(&db_pool).await {
        for addr in list {
            blacklist.insert(addr);
        }
        info!("🚫 [Blacklist] Loaded {} entries from DB", blacklist.len());
    }

    let state = ServerState {
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
        blacklist: blacklist.clone(),
    };

    // ✨ 启动黑名单 TTL 清理任务 (每小时运行一次，24小时过期)
    let db_pool_for_prune = state.db_pool.clone();
    let blacklist_for_prune = state.blacklist.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            match kline_handler::prune_blacklist(&db_pool_for_prune, 24 * 3600).await {
                Ok(count) => {
                    if count > 0 {
                        info!("🧹 [Blacklist Prune] Removed {} expired entries", count);
                        // 同步刷新内存缓存
                        if let Ok(list) = kline_handler::get_blacklist(&db_pool_for_prune).await {
                            blacklist_for_prune.clear();
                            for addr in list {
                                blacklist_for_prune.insert(addr);
                            }
                        }
                    }
                }
                Err(e) => tracing::error!("❌ [Blacklist Prune ERR] {}", e),
            }
        }
    });

    state
}
