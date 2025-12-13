// packages/backend/src/state.rs
use super::types::Room;
use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

pub type AppState = Arc<DashMap<String, Room>>;
pub type NarrativeCache = Arc<DashMap<String, String>>;

// ✨ 反向索引: Token Address (Lower) -> Set<RoomName>
pub type RoomIndex = Arc<DashMap<String, HashSet<String>>>;

#[derive(Debug, Clone)]
pub enum SubscriptionCommand {
    Subscribe(String),
    Unsubscribe(String),
}

// ✨ Token Manager Map: Token Address (Lower) -> Sender<SubscriptionCommand>
// 用于向特定 Token 的 Worker 发送指令 (Subscribe/Unsubscribe/Shutdown)
// 这里的 Sender 通常是 mpsc::UnboundedSender<SubscriptionCommand>
pub type TokenManagerMap = Arc<DashMap<String, UnboundedSender<SubscriptionCommand>>>;

pub fn new_token_manager_map() -> TokenManagerMap {
    Arc::new(DashMap::new())
}

pub fn new_app_state() -> AppState {
    Arc::new(DashMap::new())
}

pub fn new_narrative_cache() -> NarrativeCache {
    Arc::new(DashMap::new())
}

pub fn new_room_index() -> RoomIndex {
    Arc::new(DashMap::new())
}