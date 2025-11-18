// packages/backend/src/types.rs
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use sqlx::FromRow;
use std::collections::HashSet;
use tokio::task::JoinHandle;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarketItem {
    pub contract_address: Option<String>,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    pub chain: Option<String>,
    pub price: Option<f64>,
    pub market_cap: Option<f64>,
    pub chain_id: Option<String>,
    pub volume1m: Option<f64>,
    pub volume5m: Option<f64>,
    pub volume1h: Option<f64>,
    pub volume4h: Option<f64>,
    pub volume24h: Option<f64>,
    pub price_change1m: Option<f64>,
    pub price_change5m: Option<f64>,
    pub price_change1h: Option<f64>,
    pub price_change4h: Option<f64>,
    pub price_change24h: Option<f64>,
}


#[derive(Debug, Deserialize, Clone)]
pub struct KlineSubscribePayload {
    pub address: String,
    pub chain: String,
    pub interval: String,
}

#[derive(Debug, Deserialize)]
pub struct DataPayload {
    pub r#type: String,
    pub data: Vec<MarketItem>,
}


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
    pub t0a: String,
    pub t1a: String,
    pub t0pu: f64,
    pub t1pu: f64,
    pub v: f64,
    pub tp: String,
}


#[derive(Debug, Serialize, Clone)]
pub struct KlineBroadcastData {
    pub room: String,
    pub data: KlineTick,
}

// --- 核心修复：从下面的 derive 宏中移除 `FromRow` ---
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KlineTick {
    #[serde(with = "chrono::serde::ts_seconds")]
    pub time: DateTime<Utc>,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}


pub struct Room {
    pub clients: HashSet<Sid>,
    pub task_handle: JoinHandle<()>,
    pub symbol: String,
}


#[derive(Debug, Deserialize)]
pub struct ImageProxyQuery {
    pub url: String,
}

#[derive(Serialize, Deserialize)]
pub struct CacheMeta {
    pub content_type: String,
}


#[derive(Debug, Deserialize)]
pub struct HistoricalDataWrapper {
    pub data: Vec<Vec<serde_json::Value>>,
}