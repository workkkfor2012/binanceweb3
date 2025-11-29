// packages/backend/src/state.rs
use super::types::Room;
use dashmap::DashMap;
use std::sync::Arc;

pub type AppState = Arc<DashMap<String, Room>>;

// ✨ Narrative Cache: ContractAddress -> Narrative Text
// 缓存说明文本，避免每次推送都重复请求 API
pub type NarrativeCache = Arc<DashMap<String, String>>;

pub fn new_app_state() -> AppState {
    Arc::new(DashMap::new())
}

pub fn new_narrative_cache() -> NarrativeCache {
    Arc::new(DashMap::new())
}