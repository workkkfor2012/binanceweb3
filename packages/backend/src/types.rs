// packages/backend/src/types.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;

// ==============================================================================
// 1. 定义独立的数据项结构体
// ==============================================================================

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotlistItem {
    pub chain: String,
    pub contract_address: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub price: Option<f64>,
    pub market_cap: Option<f64>,
    pub volume1h: Option<f64>,
    pub volume24h: Option<f64>,
    pub price_change1h: Option<f64>,
    pub price_change24h: Option<f64>,
    pub volume5m: Option<f64>,
    pub price_change5m: Option<f64>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemeItem {
    pub chain: String,
    pub contract_address: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub name: String,
    pub progress: f64,
    pub holders: i64,
    pub dev_migrate_count: Option<i64>,
    pub create_time: i64,
    pub status: Option<String>,
    pub update_time: Option<i64>,
    pub twitter: Option<String>,
    pub telegram: Option<String>,
    pub website: Option<String>,
    pub liquidity: Option<f64>,
    pub market_cap: Option<f64>,
    pub narrative: Option<String>,
    pub source: Option<String>,
}

// ==============================================================================
// 2. Payload 定义
// ==============================================================================

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone)]
pub enum DataAction {
    #[serde(rename = "snapshot")]
    Snapshot,
    #[serde(rename = "update")]
    Update,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "category")]
pub enum DataPayload {
    #[serde(rename = "hotlist")]
    Hotlist {
        r#type: DataAction,
        data: Vec<HotlistItem>,
    },
    #[serde(rename = "meme_new")]
    MemeNew {
        r#type: DataAction,
        data: Vec<MemeItem>,
    },
    #[serde(rename = "meme_migrated")]
    MemeMigrated {
        r#type: DataAction,
        data: Vec<MemeItem>,
    },
    #[serde(other)]
    Unknown,
}

// ==============================================================================
// 3. 辅助结构
// ==============================================================================

#[derive(Debug, Deserialize)]
pub struct NarrativeResponse {
    pub code: String,
    pub data: Option<NarrativeData>,
    pub success: bool,
}

#[derive(Debug, Deserialize)]
pub struct NarrativeData {
    pub text: Option<NarrativeText>,
}

#[derive(Debug, Deserialize)]
pub struct NarrativeText {
    pub en: Option<String>,
    pub cn: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct KlineSubscribePayload {
    pub address: String,
    pub chain: String,
    pub interval: String,
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
    pub a0: f64,
    pub a1: f64,
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

// ✨ 修改核心：Room 不再持有 task_handle
pub struct Room {
    pub clients: HashSet<Sid>,
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