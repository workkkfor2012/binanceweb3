// packages/backend/src/kline_handler.rs

use crate::{
    client_pool::ClientPool,
    types::{HistoricalDataWrapper, KlineHistoryResponse, KlineSubscribePayload, KlineTick, LiquidityPoint},
    ServerState,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::Value;
use socketioxide::extract::{Data, SocketRef};
use sqlx::{
    sqlite::{SqlitePool, SqliteRow},
    Row,
};
use std::collections::HashMap;
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

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS liquidity_history_1m (
            address TEXT NOT NULL,
            time_bucket INTEGER NOT NULL,
            value REAL NOT NULL,
            PRIMARY KEY (address, time_bucket)
        )"
    )
    .execute(pool)
    .await?;
    info!("🗃️ 'liquidity_history_1m' table is ready.");

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

    // ✨ HYDRATION: Fill gaps before sending
    let hydrated_data = fill_kline_gaps(initial_data, &payload.interval, MAX_KLINES as usize);

    // 查询流动性历史
    let liquidity_history = query_liquidity_history(&state.db_pool, &payload.address)
        .await
        .ok(); // 失败时返回 None，不阻塞主流程

    let initial_response = KlineHistoryResponse {
        address: payload.address.clone(),
        chain: payload.chain.clone(),
        interval: payload.interval.clone(),
        data: hydrated_data,
        liquidity_history,
    };
    s.emit("historical_kline_initial", &initial_response).ok();

    // 2. Fetch missing
    tokio::spawn(async move {
        let _ = complete_kline_data(&payload, &state, &primary_key, &s).await;
    });
}

pub async fn handle_liquidity_request(
    s: SocketRef,
    Data(payload): Data<KlineSubscribePayload>,
    state: ServerState,
) {
    // 使用聚合查询，根据前端请求的 interval 返回对应周期的流动性数据
    if let Ok(history) = query_liquidity_history_aggregated(&state.db_pool, &payload.address, &payload.interval).await {
        let resp = KlineHistoryResponse {
            address: payload.address.clone(),
            chain: payload.chain.clone(),
            interval: payload.interval.clone(),
            data: vec![],
            liquidity_history: Some(history),
        };
        s.emit("historical_liquidity_initial", &resp).ok();
    }
}

// 请保留原文件中 complete_kline_data, fetch_historical_data_with_pool, DB操作函数 等
// 确保 fetch_historical_data_with_pool 使用 state.client_pool
async fn complete_kline_data(
    payload: &KlineSubscribePayload,
    state: &ServerState,
    primary_key: &str,
    s: &SocketRef,
) -> Result<Option<usize>> {
    let last_kline = get_last_kline_from_db(&state.db_pool, primary_key).await?;
    let interval_ms = interval_to_ms(&payload.interval);
    let now_ts = Utc::now().timestamp_millis();
    
    // ✨ 智能计算 Limit
    let limit = match last_kline {
        Some(last) => {
            let last_ts = last.time.timestamp_millis();
            let diff_ms = now_ts - last_ts;
            let missing_count = (diff_ms / interval_ms) + 1; // +1 以覆盖最后一根可能未完成的 K 线
            
            if missing_count > MAX_KLINES {
                info!("⚠️ [KLINE STALE] 数据过旧 (缺少 {} 根). 清空缓存并重新拉取: {}", missing_count, primary_key);
                clear_kline_cache(&state.db_pool, primary_key).await?;
                MAX_KLINES
            } else {
                let final_limit = missing_count.max(2).min(MAX_KLINES); // 至少取 2 根以确保覆盖最新和前一根
                info!("🔄 [KLINE SYNC] 缺少约 {} 根. 请求 limit={}", missing_count - 1, final_limit);
                final_limit
            }
        }
        None => MAX_KLINES,
    };

    let new_klines = fetch_historical_data_with_pool(&state.client_pool, payload, limit).await?;
    
    // Save new raw data to DB first
    if !new_klines.is_empty() {
        save_klines_to_db(&state.db_pool, primary_key, &new_klines).await?;
    }

    // ✨ HYDRATION: Always read back the FULL updated set from DB and hydrate
    let full_raw_data = get_klines_from_db(&state.db_pool, primary_key).await.unwrap_or_default();
    
    if !full_raw_data.is_empty() {
        let hydrated_data = fill_kline_gaps(full_raw_data, &payload.interval, MAX_KLINES as usize);

        // 查询流动性历史
        let liquidity_history = query_liquidity_history(&state.db_pool, &payload.address)
            .await
            .ok();

        let resp = KlineHistoryResponse {
            address: payload.address.clone(),
            chain: payload.chain.clone(),
            interval: payload.interval.clone(),
            data: hydrated_data.clone(),
            liquidity_history,
        };
        s.emit("historical_kline_completed", &resp).ok();
        
        let latest_candidate = hydrated_data.last().cloned();
        
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
    }

    Ok(Some(new_klines.len()))
}

async fn clear_kline_cache(pool: &SqlitePool, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM klines WHERE primary_key = ?").bind(key).execute(pool).await?;
    Ok(())
}

async fn fetch_historical_data_with_pool(
    pool: &ClientPool,
    payload: &KlineSubscribePayload,
    limit: i64,
) -> Result<Vec<KlineTick>> {
    let formatted_interval = format_interval_for_api(&payload.interval);
    
    // Normalize platform name (e.g. SOL -> solana)
    let platform = if payload.chain.eq_ignore_ascii_case("SOL") { "solana" } else { &payload.chain };

    let url = API_URL_TEMPLATE
        .replace("{address}", &payload.address)
        .replace("{platform}", platform)
        .replace("{interval}", &formatted_interval)
        .replace("{limit}", &limit.to_string());
    
    info!("🔗 [KLINE Request] URL: {}", url);

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
    
    let start = Instant::now();
    let mut tx = pool.begin().await.context("Failed to begin transaction for save_klines")?;
    let tx_time = start.elapsed().as_millis();
    
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
    
    tx.commit().await.context("Failed to commit transaction for save_klines")?;
    let total_time = start.elapsed().as_millis();
    
    info!("💾 [DB WRITE: KLINE] {} records saved for {}. (Total: {}ms, TxBegin: {}ms)", klines.len(), key, total_time, tx_time);
    
    if deleted.rows_affected() > 0 {
        info!("🧹 [PRUNE] {} 删除了 {} 条旧K线数据", key, deleted.rows_affected());
    }
    
    Ok(())
}

/// 记录流动性快照（1分钟桶）
pub async fn record_liquidity_snapshot(
    pool: &SqlitePool,
    address: &str,
    liquidity: f64,
) -> Result<()> {
    let start = Instant::now();
    let now_secs = Utc::now().timestamp();
    let time_bucket = (now_secs / 60) * 60; // 对齐到分钟
    let addr_lower = address.to_lowercase();
    
    sqlx::query(
        "INSERT OR REPLACE INTO liquidity_history_1m (address, time_bucket, value) 
         VALUES (?, ?, ?)"
    )
    .bind(&addr_lower)
    .bind(time_bucket)
    .bind(liquidity)
    .execute(pool)
    .await?;
    
    let elapsed = start.elapsed().as_millis();
    if elapsed > 100 {
        warn!("⏳ [DB SLOW: LIQUIDITY] addr={}, value={}, {}ms", addr_lower, liquidity, elapsed);
    } else {
        info!("💾 [DB WRITE: LIQUIDITY] addr={}, value={}, {}ms", addr_lower, liquidity, elapsed);
    }
    Ok(())
}

/// 批量记录流动性快照（显著减少连接获取压力）
pub async fn record_liquidity_batch(
    pool: &SqlitePool,
    items: Vec<(String, f64)>,
) -> Result<()> {
    if items.is_empty() { return Ok(()); }
    
    let start = Instant::now();
    let now_secs = Utc::now().timestamp();
    let time_bucket = (now_secs / 60) * 60;
    
    let mut tx = pool.begin().await.context("Failed to begin transaction for batch liquidity")?;
    let tx_time = start.elapsed().as_millis();
    
    for (address, liquidity) in &items {
        let addr_lower = address.to_lowercase();
        sqlx::query(
            "INSERT OR REPLACE INTO liquidity_history_1m (address, time_bucket, value) 
             VALUES (?, ?, ?)"
        )
        .bind(&addr_lower)
        .bind(time_bucket)
        .bind(*liquidity)
        .execute(&mut *tx)
        .await?;
    }
    
    tx.commit().await.context("Failed to commit transaction for batch liquidity")?;
    let total_time = start.elapsed().as_millis();
    
    info!("💾 [DB BATCH: LIQUIDITY] Saved {} items. (Total: {}ms, TxBegin: {}ms)", items.len(), total_time, tx_time);
    
    Ok(())
}

/// 查询流动性历史（最新 500 条，时间升序）
pub async fn query_liquidity_history(
    pool: &SqlitePool,
    address: &str,
) -> Result<Vec<LiquidityPoint>> {
    let addr_lower = address.to_lowercase();
    // 子查询：先降序取最新 500 条，再外层升序排列
    sqlx::query_as::<_, LiquidityPoint>(
        "SELECT time_bucket, value FROM (
            SELECT time_bucket, value FROM liquidity_history_1m 
            WHERE address = ? 
            ORDER BY time_bucket DESC 
            LIMIT 500
        ) ORDER BY time_bucket ASC"
    )
    .bind(&addr_lower)
    .fetch_all(pool)
    .await
    .context("查询流动性历史失败")
}

/// 查询流动性历史并聚合到指定周期
/// 取每个周期内最后一个 1 分钟桶的值（收盘值语义）
pub async fn query_liquidity_history_aggregated(
    pool: &SqlitePool,
    address: &str,
    interval: &str, // "1m", "5m", "15m", "1h"
) -> Result<Vec<LiquidityPoint>> {
    let interval_secs: i64 = match interval {
        "5m" => 300,
        "15m" => 900,
        "1h" => 3600,
        _ => 60, // 默认 1 分钟，无需聚合
    };

    let addr_lower = address.to_lowercase();
    info!("📊 [LIQUIDITY QUERY] 地址={}, 周期={}, 聚合秒数={}", addr_lower, interval, interval_secs);

    // 如果是 1 分钟，直接调用原函数
    if interval_secs == 60 {
        return query_liquidity_history(pool, address).await;
    }

    // 使用窗口函数取每个聚合桶内 time_bucket 最大的记录
    // 先按聚合桶分组，取每组最后一条，然后外层升序排列
    let rows = sqlx::query_as::<_, LiquidityPoint>(
        r#"
        SELECT 
            (time_bucket / ?1) * ?1 AS time_bucket,
            value
        FROM liquidity_history_1m AS outer_t
        WHERE address = ?2
          AND time_bucket = (
              SELECT MAX(inner_t.time_bucket)
              FROM liquidity_history_1m AS inner_t
              WHERE inner_t.address = outer_t.address
                AND (inner_t.time_bucket / ?1) = (outer_t.time_bucket / ?1)
          )
        ORDER BY time_bucket ASC
        LIMIT 500
        "#
    )
    .bind(interval_secs)
    .bind(&addr_lower)
    .fetch_all(pool)
    .await
    .context("查询聚合流动性历史失败")?;

    info!("📊 [LIQUIDITY QUERY] 返回 {} 条聚合记录", rows.len());
    Ok(rows)
}

/// 清理 24 小时前的流动性历史数据
pub async fn prune_liquidity_history(pool: &SqlitePool) -> Result<u64> {
    let cutoff = Utc::now().timestamp() - (24 * 3600);
    let result = sqlx::query("DELETE FROM liquidity_history_1m WHERE time_bucket < ?")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// ✨ Gap Filling Implementation
fn fill_kline_gaps(mut raw_data: Vec<KlineTick>, interval_str: &str, target_count: usize) -> Vec<KlineTick> {
    if raw_data.is_empty() {
        return vec![];
    }

    let interval_ms = interval_to_ms(interval_str);
    if interval_ms == 0 {
        return raw_data;
    }
    let interval_dur = Duration::milliseconds(interval_ms);

    // 1. Determine End Time (Aligned to current time)
    let now = Utc::now();
    let now_ts = now.timestamp_millis();
    let aligned_end_ts = (now_ts / interval_ms) * interval_ms;
    let end_time = Utc.timestamp_millis_opt(aligned_end_ts).unwrap();

    // 2. Determine Start Time
    let start_time = end_time - (interval_dur * (target_count as i32 - 1));

    // 3. Map for O(1) lookup
    let data_map: HashMap<i64, KlineTick> = raw_data
        .drain(..)
        .map(|k| (k.time.timestamp_millis(), k))
        .collect();

    let mut filled_data = Vec::with_capacity(target_count);
    let mut last_close = 0.0;
    
    // Try to find an initial close if the start of window is empty
    // "Backfill" strategy: Use average of the 2nd LATEST kline's open and close
    // to anchor the historical flat line to the recent price level.
    let mut sorted_real_data: Vec<&KlineTick> = data_map.values().collect();
    sorted_real_data.sort_by_key(|k| k.time);

    if sorted_real_data.len() >= 2 {
        let second_latest = &sorted_real_data[sorted_real_data.len() - 2];
        last_close = (second_latest.open + second_latest.close) / 2.0;
    } else if let Some(first) = sorted_real_data.first() {
        last_close = first.close;
    }

    let mut curr = start_time;
    for _ in 0..target_count {
        let ts = curr.timestamp_millis();
        
        if let Some(mut existing) = data_map.get(&ts).cloned() {
            // Data exists
            last_close = existing.close;
            filled_data.push(existing);
        } else {
            // Gap -> Fill
            let synthetic = KlineTick {
                time: curr,
                open: last_close,
                high: last_close,
                low: last_close,
                close: last_close,
                volume: 0.0,
            };
            filled_data.push(synthetic);
        }

        curr = curr + interval_dur;
    }

    filled_data
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
