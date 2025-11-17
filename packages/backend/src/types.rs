// packages/backend/src/types.rs
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use std::collections::HashSet;
use tokio::task::JoinHandle;

// --- WebSocket & Socket.IO Payloads ---

#[derive(Debug, Deserialize, Clone)]
pub struct KlineSubscribePayload {
    pub address: String,
    pub chain: String,
    pub interval: String,
}

#[derive(Debug, Deserialize)]
pub struct BinanceStreamWrapper {
    pub stream: String,
    pub data: BinanceKlineData,
}

#[derive(Debug, Deserialize)]
pub struct BinanceKlineData {
    pub d: BinanceKlineDetail,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub struct BinanceKlineDetail {
    // Tuples represent: Open, High, Low, Close, Volume, Timestamp
    pub u: (String, String, String, String, String, String),
}

#[derive(Debug, Serialize, Clone)]
pub struct KlineBroadcastData {
    pub room: String,
    pub data: KlineTick,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KlineTick {
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

// --- Application State Component ---

pub struct Room {
    pub clients: HashSet<Sid>,
    pub task_handle: JoinHandle<()>,
}

// --- HTTP Payloads ---

#[derive(Debug, Deserialize)]
pub struct ImageProxyQuery {
    pub url: String,
}

#[derive(Serialize, Deserialize)]
pub struct CacheMeta {
    pub content_type: String,
}