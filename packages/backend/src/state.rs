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

#[derive(Clone)]
pub struct BinanceChannels {
    pub kline_tx: UnboundedSender<SubscriptionCommand>,
    pub tick_tx: UnboundedSender<SubscriptionCommand>,
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