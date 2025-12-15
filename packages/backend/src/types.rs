// packages/backend/src/types.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;

// ==============================================================================
// 1. 定义 Trait：通用行为 (NarrativeEntity)
//    只要实现了这个特征，都可以被 socket_handlers 中的 enrich_any_data 处理
// ==============================================================================
pub trait NarrativeEntity {
    fn get_address(&self) -> &str;
    fn get_chain(&self) -> &str;
    fn set_narrative(&mut self, narrative: String);
    fn get_narrative(&self) -> Option<&str>;
    // 🔥 新增：获取 Narrative 专用 ChainID (如 "CT_501")
    fn get_narrative_chain_id(&self) -> Option<String>;
}

// ==============================================================================
// 2. 结构体 A: Hotlist (精简市场数据)
// ==============================================================================
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HotlistItem {
    pub chain: String,
    pub contract_address: String,
    pub symbol: String,
    pub icon: Option<String>,
    
    // 价格相关 (Hotlist 通常已经是数字，使用 Option<f64> 兼容可能的 null)
    pub price: Option<f64>,
    pub market_cap: Option<f64>,
    pub volume1h: Option<f64>,
    pub volume24h: Option<f64>,
    pub price_change1h: Option<f64>,
    pub price_change24h: Option<f64>,
    pub volume5m: Option<f64>,
    pub price_change5m: Option<f64>,
    
    pub source: Option<String>,
    pub narrative: Option<String>,
}

impl NarrativeEntity for HotlistItem {
    fn get_address(&self) -> &str { &self.contract_address }
    fn get_chain(&self) -> &str { &self.chain }
    fn set_narrative(&mut self, n: String) { self.narrative = Some(n); }
    fn get_narrative(&self) -> Option<&str> { self.narrative.as_deref() }
    fn get_narrative_chain_id(&self) -> Option<String> { None }
}

// ==============================================================================
// 3. 结构体 B: MemeScanItem (全量数据 - 对应 Extractor 的输出)
//    🔥 已修正：类型与 meme-extractor.ts 的 safeInt/safeFloat/safeBool 对应
// ==============================================================================
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemeScanItem {
    // --- 基础信息 (String) ---
    pub chain: String,
    pub contract_address: String,
    pub symbol: String,
    pub name: String,
    
    // 可选字符串
    pub icon: Option<String>,
    pub chain_id: Option<String>, 
    pub ca_icon: Option<String>,      
    pub icon_status: Option<String>,  
    pub ca_icon_status: Option<String>,
    pub protocol: Option<String>,     
    pub height: Option<String>,
    pub first_seen: Option<String>,
    pub migrate_status: Option<String>,
    pub status: Option<String>,
    
    // --- 整数类型 (safeInt -> i64) ---
    pub decimal: i64,      
    pub create_time: i64,       
    pub migrate_time: i64, 
    pub display_time: i64,
    pub update_time: Option<i64>, // TS 中是 Date.now()，但也可能没发
    pub holders: i64,
    pub count: i64,     
    pub count_buy: i64, 
    pub count_sell: i64,
    pub dev_migrate_count: i64,

    // --- 浮点数类型 (safeFloat -> f64) ---
    pub progress: f64,
    pub liquidity: Option<f64>,
    pub market_cap: Option<f64>,
    pub volume: Option<f64>,
    pub buy_sell_ratio: f64,

    // 🔥 报错修复点：百分比数据现在接收浮点数 (如 86, 45.5)
    pub holders_top10_percent: f64, 
    pub holders_dev_percent: f64,
    pub holders_sniper_percent: f64,
    pub holders_insider_percent: f64,
    pub dev_sell_percent: f64,
    
    // --- 布尔类型 (safeBool -> bool) ---
    pub sensitive_token: bool, 
    pub exclusive: bool,    
    pub paid_on_dex_screener: bool, 

    // --- 社交 ---
    pub twitter: Option<String>,
    pub telegram: Option<String>,
    pub website: Option<String>,
    
    pub narrative: Option<String>,
    pub source: Option<String>,
}

impl NarrativeEntity for MemeScanItem {
    fn get_address(&self) -> &str { &self.contract_address }
    fn get_chain(&self) -> &str { &self.chain }
    fn set_narrative(&mut self, n: String) { self.narrative = Some(n); }
    fn get_narrative(&self) -> Option<&str> { self.narrative.as_deref() }
    fn get_narrative_chain_id(&self) -> Option<String> { self.chain_id.clone() }
}

// ==============================================================================
// 4. Payload 定义 (交通枢纽)
// ==============================================================================

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone)]
pub enum DataAction {
    #[serde(rename = "snapshot")]
    Snapshot,
    #[serde(rename = "update")]
    Update,
    #[serde(rename = "full")] // 🔥 新增：匹配爬虫发送的 type: "full"
    Full, 
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "category")]
pub enum DataPayload {
    // 1. Hotlist -> 使用 HotlistItem
    #[serde(rename = "hotlist")]
    Hotlist {
        r#type: DataAction,
        data: Vec<HotlistItem>,
    },
    // 2. Meme New -> 使用 MemeScanItem
    #[serde(rename = "meme_new")]
    MemeNew {
        r#type: DataAction,
        data: Vec<MemeScanItem>,
    },
    // 3. Meme Migrated -> 使用 MemeScanItem
    #[serde(rename = "meme_migrated")]
    MemeMigrated {
        r#type: DataAction,
        data: Vec<MemeScanItem>,
    },
    #[serde(other)]
    Unknown,
}

// ... (以下保留之前的辅助结构不变) ...
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