// packages/backend/src/state.rs
use super::types::Room;
use dashmap::DashMap;
use std::sync::Arc;

pub type AppState = Arc<DashMap<String, Room>>;

pub fn new_app_state() -> AppState {
    Arc::new(DashMap::new())
}