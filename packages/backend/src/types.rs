// packages/backend/src/types.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use socketioxide::socket::Sid;
use ts_rs::TS;
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
#[derive(Debug, Deserialize, Serialize, Clone, TS)]
#[ts(export, export_to = "../../shared-types/src/bindings/HotlistItem.ts")]
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
    pub volume1m: Option<f64>,
    pub price_change1m: Option<f64>,
    pub volume4h: Option<f64>,
    pub price_change4h: Option<f64>,
    
    #[ts(optional)]
    pub source: Option<String>,
    #[ts(optional)]
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
#[derive(Debug, Deserialize, Serialize, Clone, TS)]
#[ts(export, export_to = "../../shared-types/src/bindings/MemeScanItem.ts")]
#[serde(rename_all = "camelCase")]
pub struct MemeScanItem {
    // --- 基础信息 (String) ---
    pub chain: String,
    pub contract_address: String,
    pub symbol: String,
    pub name: String,
    
    // 可选字符串
    #[ts(optional)]
    pub icon: Option<String>,
    #[ts(optional)]
    pub chain_id: Option<String>, 
    #[ts(optional)]
    pub ca_icon: Option<String>,      
    #[ts(optional)]
    pub icon_status: Option<String>,  
    #[ts(optional)]
    pub ca_icon_status: Option<String>,
    #[ts(optional)]
    pub protocol: Option<String>,     
    #[ts(optional)]
    pub height: Option<String>,
    #[ts(optional)]
    pub first_seen: Option<String>,
    #[ts(optional)]
    pub migrate_status: Option<String>,
    #[ts(optional)]
    pub status: Option<String>,
    
    // --- 整数类型 (safeInt -> i64) ---
    #[ts(type = "number")]
    pub decimal: i64,      
    #[ts(type = "number")]
    pub create_time: i64,       
    #[ts(type = "number")]
    pub migrate_time: i64, 
    #[ts(type = "number")]
    pub display_time: i64,
    #[ts(optional, type = "number")]
    pub update_time: Option<i64>, // TS 中是 Date.now()，但也可能没发
    #[ts(type = "number")]
    pub holders: i64,
    #[ts(type = "number")]
    pub count: i64,     
    #[ts(type = "number")]
    pub count_buy: i64, 
    #[ts(type = "number")]
    pub count_sell: i64,
    #[ts(type = "number")]
    pub dev_migrate_count: i64,

    // --- 浮点数类型 (safeFloat -> f64) ---
    #[ts(type = "number")]
    pub progress: f64,
    #[ts(optional, type = "number")]
    pub liquidity: Option<f64>,
    #[ts(optional, type = "number")]
    pub market_cap: Option<f64>,
    #[ts(optional, type = "number")]
    pub volume: Option<f64>,
    #[ts(type = "number")]
    pub buy_sell_ratio: f64,

    // 🔥 报错修复点：百分比数据现在接收浮点数 (如 86, 45.5)
    #[ts(type = "number")]
    pub holders_top10_percent: f64, 
    #[ts(type = "number")]
    pub holders_dev_percent: f64,
    #[ts(type = "number")]
    pub holders_sniper_percent: f64,
    #[ts(type = "number")]
    pub holders_insider_percent: f64,
    #[ts(type = "number")]
    pub dev_sell_percent: f64,
    
    // --- 布尔类型 (safeBool -> bool) ---
    pub sensitive_token: bool, 
    pub exclusive: bool,    
    pub paid_on_dex_screener: bool, 

    // --- 社交 ---
    #[ts(optional)]
    pub twitter: Option<String>,
    #[ts(optional)]
    pub telegram: Option<String>,
    #[ts(optional)]
    pub website: Option<String>,
    
    #[ts(optional)]
    pub narrative: Option<String>,
    #[ts(optional)]
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

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq, Clone, TS)]
#[ts(export, export_to = "../../shared-types/src/bindings/DataAction.ts")]
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

#[derive(Debug, Deserialize, Serialize, TS)]
#[ts(export, export_to = "../../shared-types/src/bindings/DataPayload.ts")]
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
#[derive(Debug, Serialize, Clone, Default, PartialEq, TS)]
#[ts(export, export_to = "../../shared-types/src/bindings/KlineTick.ts")]
#[serde(rename_all = "camelCase")]
pub struct KlineTick {
    #[serde(with = "chrono::serde::ts_seconds")]
#[ts(type = "string")] // DateTime<Utc> 映射为 string
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_bindings() {
        // ts-rs 会在编译/测试时自动导出，但显式调用可以确保它们生成。
        // 在此处只是为了明确生成顺序。
        HotlistItem::export().expect("Failed to export HotlistItem");
        MemeScanItem::export().expect("Failed to export MemeScanItem");
        DataAction::export().expect("Failed to export DataAction");
        DataPayload::export().expect("Failed to export DataPayload");
        KlineTick::export().expect("Failed to export KlineTick");
    }
}