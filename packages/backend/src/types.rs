// packages/backend/src/types.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use sqlx::FromRow;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
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

// ✨ 1. 定义业务分类 (Category)
#[derive(Debug, Deserialize, PartialEq, Eq, Hash, Clone)]
pub enum DataCategory {
    #[serde(rename = "hotlist")]
    Hotlist,
    #[serde(rename = "new")]
    New,
    #[serde(other)]
    Unknown,
}

// ✨ 2. 定义动作类型 (Action/Type)
#[derive(Debug, Deserialize, PartialEq, Eq, Clone)]
pub enum DataAction {
    #[serde(rename = "snapshot")]
    Snapshot,
    #[serde(rename = "update")]
    Update,
    #[serde(other)]
    Unknown,
}

// ✨ 3. 更新后的 Payload 结构
#[derive(Debug, Deserialize)]
pub struct DataPayload {
    pub category: DataCategory,
    pub r#type: DataAction,
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

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KlineHistoryResponse {
    pub address: String,
    pub chain: String,
    pub interval: String,
    pub data: Vec<KlineTick>,
}

pub struct Room {
    pub clients: HashSet<Sid>,
    pub task_handle: JoinHandle<()>,
    pub symbol: String,
    pub current_kline: Arc<Mutex<Option<KlineTick>>>,
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