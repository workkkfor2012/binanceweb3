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

// --- Binance Incoming Data Structures ---

#[derive(Debug, Deserialize)]
pub struct BinanceStreamWrapper<T> {
    pub stream: String,
    pub data: T,
}

#[derive(Debug, Deserialize)]
pub struct BinanceKlineDataWrapper {
    #[serde(rename = "d")]
    pub kline_data: BinanceKlineDetail,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub struct BinanceKlineDetail {
    // Tuples represent: Open, High, Low, Close, Volume, Timestamp
    #[serde(rename = "u")]
    pub values: (String, String, String, String, String, String),
}

#[derive(Debug, Deserialize)]
pub struct BinanceTickDataWrapper {
    #[serde(rename = "d")]
    pub tick_data: BinanceTickDetail,
}

#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub struct BinanceTickDetail {
    pub t0pu: String, // Price
    pub v: String,    // Volume in USD
    pub tp: String,   // Side ("BUY" or "SELL")
}


// --- Data Sent to Frontend ---

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