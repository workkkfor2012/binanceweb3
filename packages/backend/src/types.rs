// packages/backend/src/types.rs
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use std::collections::HashSet;
use tokio::task::JoinHandle;
// use shared_types::MarketItem; // <-- 移除错误的导入

// --- 核心修复: 在 Rust 中定义 MarketItem 结构 ---
// 这个结构必须与 extractor 发送的 JSON 数据结构完全匹配。
// 使用 Option<T> 来处理可能为空的字段，增加健壮性。
// `rename_all = "camelCase"` 自动将 Rust 的 snake_case 字段名映射到 JSON 的 camelCase 字段名。
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MarketItem {
    pub contract_address: Option<String>,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    pub chain: Option<String>,
    pub price: Option<f64>,
    pub market_cap: Option<f64>,
    // --- 核心修改 ---
    // 将 chain_id 的类型从 i64 改为 String，以匹配 extractor 发送的实际数据类型。
    // 日志显示该字段可能为 "8453" 或 "CT_501" 等字符串。
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


// --- WebSocket & Socket.IO Payloads ---

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


// --- Data Sent to Frontend ---

#[derive(Debug, Serialize, Clone)]
pub struct KlineBroadcastData {
    pub room: String,
    pub data: KlineTick,
}

#[derive(Debug, Serialize, Clone, Default)]
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
    pub symbol: String, 
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