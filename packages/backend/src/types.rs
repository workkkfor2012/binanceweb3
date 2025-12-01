// packages/backend/src/types.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

// ==============================================================================
// 1. 定义独立的数据项结构体 (对应 shared-types)
// ==============================================================================

// 🟢 1.1 Hotlist 专用结构体 (对应 TypeScript 的 HotlistItem)
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotlistItem {
    // --- BaseItem 字段 (重复定义以解耦) ---
    pub chain: String,
    pub contract_address: String,
    pub symbol: String,
    pub icon: Option<String>,

    // --- Hotlist 核心字段 ---
    pub price: Option<f64>,
    pub market_cap: Option<f64>,
    pub volume1h: Option<f64>,
    pub volume24h: Option<f64>,
    pub price_change1h: Option<f64>,
    pub price_change24h: Option<f64>,

    // --- 额外 K线 字段 ---
    pub volume5m: Option<f64>,
    pub price_change5m: Option<f64>,

    // 来源标记
    pub source: Option<String>,
}

// 🔵 1.2 Meme Rush 专用结构体 (对应 TypeScript 的 MemeItem)
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemeItem {
    // --- BaseItem 字段 ---
    pub chain: String,
    pub contract_address: String,
    pub symbol: String,
    pub icon: Option<String>,

    // --- Meme 核心字段 ---
    pub name: String,
    pub progress: f64,                  // 绑定曲线进度 (0-100)
    pub holders: i64,
    pub dev_migrate_count: Option<i64>, // 可能为null
    pub create_time: i64,

    // ✨ 新增: 兼容 migrated 数据中的字段
    pub status: Option<String>, // e.g. "dex"
    pub update_time: Option<i64>,

    // 社交
    pub twitter: Option<String>,
    pub telegram: Option<String>,
    pub website: Option<String>,

    // Meme 交易属性
    pub liquidity: Option<f64>,
    pub market_cap: Option<f64>,

    // ✨ 新增: 项目描述 (从 Binance Narrative API 获取)
    pub narrative: Option<String>,

    // 来源标记
    pub source: Option<String>,
}

// ==============================================================================
// 2. 定义严格分流的 Payload (核心解耦点)
// ==============================================================================

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone)]
pub enum DataAction {
    #[serde(rename = "snapshot")]
    Snapshot,
    #[serde(rename = "update")]
    Update,
    #[serde(other)]
    Unknown, // 处理 "full" 或其他未预期的 action
}

// ✨ 利用 serde(tag = "category") 实现自动分流
// 当 category="hotlist" 时，data 被解析为 Vec<HotlistItem>
// 当 category="meme_new" 时，data 被解析为 Vec<MemeItem>
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

    // ✨ 新增: 处理已发射(Migrated)的 Meme 代币
    #[serde(rename = "meme_migrated")]
    MemeMigrated {
        r#type: DataAction,
        data: Vec<MemeItem>, // 复用 MemeItem 结构
    },

    // 处理未知的分类，防止报错崩溃
    #[serde(other)]
    Unknown,
}

// ==============================================================================
// 3. 其他辅助结构 (Binance/KLine/Socket/API)
// ==============================================================================

// ✨ 新增: Binance Narrative API 响应结构
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