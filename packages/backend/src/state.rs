// packages/backend/src/state.rs
use super::types::Room;
use dashmap::DashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

pub type AppState = Arc<DashMap<String, Room>>;

// ✨ Narrative Cache: ContractAddress -> Narrative Text
pub type NarrativeCache = Arc<DashMap<String, String>>;

// ✨ 反向索引: Token Address -> Set<RoomName>
// 用于 Tick 数据更新时，快速找到需要推送的房间
pub type RoomIndex = Arc<DashMap<String, HashSet<String>>>;

// ✨ 订阅命令枚举 (用于 Channel)
#[derive(Debug, Clone)]
pub enum SubscriptionCommand {
    Subscribe(String),
    Unsubscribe(String),
}

// ✨ 全局通道结构体
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