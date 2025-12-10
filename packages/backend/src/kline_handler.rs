// packages/backend/src/kline_handler.rs

use crate::{
    client_pool::ClientPool,
    types::{HistoricalDataWrapper, KlineHistoryResponse, KlineSubscribePayload, KlineTick},
    ServerState,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use socketioxide::extract::{Data, SocketRef};
use sqlx::{
    sqlite::{SqlitePool, SqliteRow},
    Row,
};
use std::time::Instant;
use tracing::{error, info, warn};

const API_URL_TEMPLATE: &str = "https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval={interval}&limit={limit}&platform={platform}";
/// 币安API单次最多返回500根K线，也是我们缓存的上限
const MAX_KLINES: i64 = 500;

// ✨ 确保是 public
pub async fn init_db(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS klines (
            primary_key TEXT NOT NULL,
            time INTEGER NOT NULL,
            open REAL NOT NULL,
            high REAL NOT NULL,
            low REAL NOT NULL,
            close REAL NOT NULL,
            volume REAL NOT NULL,
            PRIMARY KEY (primary_key, time)
        )",
    )
    .execute(pool)
    .await?;
    info!("🗃️ 'klines' table is ready.");
    Ok(())
}

// ✨ 确保是 public
pub async fn handle_kline_request(
    s: SocketRef,
    Data(payload): Data<KlineSubscribePayload>,
    state: ServerState,
) {
    let _start_total = Instant::now();
    let primary_key = get_primary_key(&payload);

    // 1. DB Query
    let db_start = Instant::now();
    let initial_data = match get_klines_from_db(&state.db_pool, &primary_key).await {
        Ok(data) => {
            if !data.is_empty() {
                info!("💾 [DB HIT] {} records ({}ms)", data.len(), db_start.elapsed().as_millis());
            } else {
                info!("💾 [DB MISS] 0 records ({}ms)", db_start.elapsed().as_millis());
            }
            data
        }
        Err(e) => {
            error!("❌ [DB ERROR] {}", e);
            vec![]
        }
    };

    let initial_response = KlineHistoryResponse {
        address: payload.address.clone(),
        chain: payload.chain.clone(),
        interval: payload.interval.clone(),
        data: initial_data,
    };
    s.emit("historical_kline_initial", &initial_response).ok();

    // 2. Fetch missing
    tokio::spawn(async move {
        let _ = complete_kline_data(&payload, &state, &primary_key, &s).await;
    });
}

// ... (以下辅助函数保持不变，为节省篇幅略去，但文件需要包含它们) ...
// 请保留原文件中 complete_kline_data, fetch_historical_data_with_pool, DB操作函数 等
// 确保 fetch_historical_data_with_pool 使用 state.client_pool
async fn complete_kline_data(
    payload: &KlineSubscribePayload,
    state: &ServerState,
    primary_key: &str,
    s: &SocketRef,
) -> Result<Option<usize>> {
    let last_kline = get_last_kline_from_db(&state.db_pool, primary_key).await?;
    // 简化逻辑：如果没有数据或数据旧了，就去拉取
    let limit = match last_kline {
        Some(_) => 50, // 简单策略：增量拉取
        None => MAX_KLINES,
    };

    let new_klines = fetch_historical_data_with_pool(&state.client_pool, payload, limit).await?;
    
    if !new_klines.is_empty() {
        let resp = KlineHistoryResponse {
            address: payload.address.clone(),
            chain: payload.chain.clone(),
            interval: payload.interval.clone(),
            data: new_klines.clone(),
        };
        s.emit("historical_kline_completed", &resp).ok();
        save_klines_to_db(&state.db_pool, primary_key, &new_klines).await?;
    }

    // ✨ Fix: Initialize current_kline in AppState so Ticks work immediately
    let latest_candidate = if let Some(last_new) = new_klines.last() {
        Some(last_new.clone())
    } else {
        last_kline 
    };

    if let Some(kline) = latest_candidate {
        let chain_lower = payload.chain.to_lowercase();
        let pool_id = match chain_lower.as_str() {
            "bsc" => 14, "sol" | "solana" => 16, "base" => 199, _ => 0,
        };

        if pool_id > 0 {
            let room_key = format!("kl@{}@{}@{}", pool_id, payload.address.to_lowercase(), payload.interval);
            if let Some(room) = state.app_state.get(&room_key) {
                let mut guard = room.current_kline.lock().await;
                if guard.is_none() {
                    info!("✅ [KLINE INIT] Initialized current_kline for {} from history/db", room_key);
                    *guard = Some(kline);
                }
            }
        }
    }
    Ok(Some(new_klines.len()))
}

async fn fetch_historical_data_with_pool(
    pool: &ClientPool,
    payload: &KlineSubscribePayload,
    limit: i64,
) -> Result<Vec<KlineTick>> {
    let formatted_interval = format_interval_for_api(&payload.interval);
    let url = API_URL_TEMPLATE
        .replace("{address}", &payload.address)
        .replace("{platform}", &payload.chain)
        .replace("{interval}", &formatted_interval)
        .replace("{limit}", &limit.to_string());
    
    let interval_label = payload.interval.clone();

    // 简单的重试逻辑
    for _ in 0..2 {
        let (idx, client) = pool.get_client().await;
        if let Ok(res) = client.get(&url).send().await {
            if res.status().is_success() {
                if let Ok(text) = res.text().await {
                    if let Ok(wrapper) = serde_json::from_str::<HistoricalDataWrapper>(&text) {
                         return parse_api_data(&wrapper.data, &interval_label);
                    }
                }
            } else {
                pool.recycle_client(idx).await;
            }
        } else {
            pool.recycle_client(idx).await;
        }
    }
    Ok(vec![])
}

// ... DB Helpers ...
/// 获取最新的500根K线，按时间升序返回（前端需要升序渲染）
async fn get_klines_from_db(pool: &SqlitePool, key: &str) -> Result<Vec<KlineTick>> {
    // 使用子查询：先倒序取最新500根，再外层正序排列
    sqlx::query_as::<_, KlineTick>(
        "SELECT time, open, high, low, close, volume FROM (
            SELECT * FROM klines WHERE primary_key = ? ORDER BY time DESC LIMIT ?
        ) ORDER BY time ASC"
    )
    .bind(key)
    .bind(MAX_KLINES)
    .fetch_all(pool)
    .await
    .context("获取缓存K线数据失败")
}
async fn get_last_kline_from_db(pool: &SqlitePool, key: &str) -> Result<Option<KlineTick>> {
    sqlx::query_as("SELECT time, open, high, low, close, volume FROM klines WHERE primary_key = ? ORDER BY time DESC LIMIT 1")
        .bind(key).fetch_optional(pool).await.context("DB fetch last")
}
/// 保存K线数据并自动裁剪，确保每个品种/周期最多保留500根
async fn save_klines_to_db(pool: &SqlitePool, key: &str, klines: &[KlineTick]) -> Result<()> {
    if klines.is_empty() { return Ok(()); }
    
    let mut tx = pool.begin().await?;
    
    // 1. 插入/更新新数据
    for k in klines {
        sqlx::query("INSERT OR REPLACE INTO klines (primary_key, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(key).bind(k.time.timestamp()).bind(k.open).bind(k.high).bind(k.low).bind(k.close).bind(k.volume)
            .execute(&mut *tx).await?;
    }
    
    // 2. 裁剪：删除超过500根的旧数据
    let deleted = sqlx::query(
        "DELETE FROM klines WHERE primary_key = ? AND time NOT IN (
            SELECT time FROM klines WHERE primary_key = ? ORDER BY time DESC LIMIT ?
        )"
    )
    .bind(key)
    .bind(key)
    .bind(MAX_KLINES)
    .execute(&mut *tx)
    .await?;
    
    tx.commit().await?;
    
    if deleted.rows_affected() > 0 {
        info!("🧹 [PRUNE] {} 删除了 {} 条旧K线数据", key, deleted.rows_affected());
    }
    
    Ok(())
}
// Helper functions
fn get_primary_key(p: &KlineSubscribePayload) -> String { format!("{}@{}@{}", p.address, p.chain, p.interval) }
fn format_interval_for_api(i: &str) -> String { if let Some(v) = i.strip_suffix('m') { format!("{}min", v) } else { i.to_string() } }
fn interval_to_ms(i: &str) -> i64 { 
    let v: String = i.chars().take_while(|c| c.is_ascii_digit()).collect();
    let u: String = i.chars().skip_while(|c| c.is_ascii_digit()).collect();
    let val = v.parse::<i64>().unwrap_or(0);
    match u.as_str() { "m"=>val*60000, "h"=>val*3600000, "d"=>val*86400000, _=>0 }
}
fn parse_api_data(data: &[Vec<Value>], _label: &str) -> Result<Vec<KlineTick>> {
     // (Implement same parsing logic as before)
     let mut res = Vec::new();
     for d in data {
         let t = d.get(5).and_then(|v| v.as_i64()).unwrap_or(0);
         res.push(KlineTick {
             time: DateTime::from_timestamp(t/1000, 0).unwrap_or_default().with_timezone(&Utc),
             open: d.get(0).and_then(|v| v.as_f64()).unwrap_or(0.0),
             high: d.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0),
             low: d.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0),
             close: d.get(3).and_then(|v| v.as_f64()).unwrap_or(0.0),
             volume: d.get(4).and_then(|v| v.as_f64()).unwrap_or(0.0),
         });
     }
     Ok(res)
}
impl sqlx::FromRow<'_, SqliteRow> for KlineTick {
    fn from_row(row: &SqliteRow) -> sqlx::Result<Self> {
        let t: i64 = row.try_get("time")?;
        Ok(KlineTick {
            time: DateTime::from_timestamp(t, 0).unwrap_or_default().with_timezone(&Utc),
            open: row.try_get("open")?, high: row.try_get("high")?, low: row.try_get("low")?, close: row.try_get("close")?, volume: row.try_get("volume")?,
        })
    }
}