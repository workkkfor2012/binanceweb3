// packages/backend/src/kline_handler.rs

use crate::{
    client_pool::ClientPool,
    types::{HistoricalDataWrapper, KlineHistoryResponse, KlineSubscribePayload, KlineTick},
    ServerState,
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, Utc};
use reqwest::Client;
use serde_json::Value;
use socketioxide::extract::{Data, SocketRef};
use sqlx::{
    sqlite::{SqlitePool, SqliteRow},
    Row,
};
use std::time::Instant;
use tokio_retry::{strategy::ExponentialBackoff, Retry};
use tracing::{error, info, warn};

const API_URL_TEMPLATE: &str = "https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval={interval}&limit={limit}&platform={platform}";
const API_MAX_LIMIT: i64 = 500;
const DB_MAX_RECORDS: i64 = 1000;
const DB_PRUNE_TO_COUNT: i64 = 500;
const FETCH_RETRY_COUNT: usize = 3;

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

pub async fn handle_kline_request(
    s: SocketRef,
    Data(payload): Data<KlineSubscribePayload>,
    state: ServerState,
) {
    let start_total = Instant::now();
    let primary_key = get_primary_key(&payload);

    // --- 步骤 1: 立即查询数据库并返回 (同步路径) ---
    let db_start = Instant::now();
    let initial_data = match get_klines_from_db(&state.db_pool, &primary_key).await {
        Ok(data) => {
            let db_duration = db_start.elapsed();
            if !data.is_empty() {
                let last_time = data.last().unwrap().time;
                info!(
                    "💾 [DB HIT] {} records for {}. Last Candle: {} (Took {:?})",
                    data.len(),
                    primary_key,
                    last_time,
                    db_duration
                );
            } else {
                info!(
                    "💾 [DB MISS] No records found for {} (Took {:?})",
                    primary_key,
                    db_duration
                );
            }
            data
        }
        Err(e) => {
            error!("❌ [DB ERROR] for {}: {}", primary_key, e);
            vec![]
        }
    };

    // 发送初始数据
    let initial_response = KlineHistoryResponse {
        address: payload.address.clone(),
        chain: payload.chain.clone(),
        interval: payload.interval.clone(),
        data: initial_data,
    };

    if let Err(e) = s.emit("historical_kline_initial", &initial_response) {
        error!("❌ [EMIT ERROR] initial for {}: {}", primary_key, e);
    }

    info!(
        "🚀 [PERF STEP 1] {} -> DB Data Sent to Client in {:?}",
        primary_key,
        start_total.elapsed()
    );

    // --- 步骤 2: 后台补全缺失数据 (异步路径) ---
    tokio::spawn(async move {
        let api_process_start = Instant::now();

        match complete_kline_data(&payload, &state, &primary_key, &s).await {
            Ok(Some(count)) => {
                let api_duration = api_process_start.elapsed();
                let total_duration = start_total.elapsed();
                info!(
                    "📡 [PERF STEP 2] {} -> Fetched & Sent {} NEW/UPDATED candles. (API: {:?}, Total E2E: {:?})",
                    primary_key,
                    count,
                    api_duration,
                    total_duration
                );
            }
            Ok(None) => {
                // 理论上现在很少会进入这里，除非 limit <= 0
            }
            Err(e) => {
                error!("❌ [FETCH FAILED] for {}: {:?}", primary_key, e);
                let err_payload = serde_json::json!({ "key": primary_key, "error": e.to_string() });
                s.emit("kline_fetch_error", &err_payload).ok();
            }
        }
    });
}

async fn complete_kline_data(
    payload: &KlineSubscribePayload,
    state: &ServerState,
    primary_key: &str,
    s: &SocketRef,
) -> Result<Option<usize>> {
    let last_kline = get_last_kline_from_db(&state.db_pool, primary_key).await?;
    let interval_ms = interval_to_ms(&payload.interval);
    let now = Utc::now();

    let mut limit = match last_kline {
        Some(kline) => {
            let time_diff_ms = now.timestamp_millis() - kline.time.timestamp_millis();
            // 即使时间差很小，只要 interval_ms 大于 0，limit 至少为 1
            // 这保证了我们总是会去拉取最新的一根 K 线来更新它的状态
            let missing_count = (time_diff_ms / interval_ms).max(1);
            
            if missing_count > 1 {
                info!(
                    "🕵️ [CHECK {}] Gap detected. Last: {}, Now: {}, Need ~{} candles.", 
                    primary_key, kline.time, now, missing_count
                );
            } else {
                info!(
                    "🔄 [CHECK {}] Database has latest timestamp, but refreshing active candle (Limit=1).", 
                    primary_key
                );
            }
            
            missing_count
        }
        None => {
            info!("🕵️ [CHECK {}] Empty DB. Triggering full fetch (500).", primary_key);
            API_MAX_LIMIT
        },
    };

    if limit <= 0 {
        return Ok(None);
    }

    if limit > API_MAX_LIMIT {
        warn!(
            "⚠️ [STALE] {} missing {} candles (Too many). Resetting to {}.",
            primary_key, limit, API_MAX_LIMIT
        );
        clear_klines_from_db(&state.db_pool, primary_key).await?;
        limit = API_MAX_LIMIT;
    }

    // 执行网络请求
    let new_klines = fetch_historical_data_with_pool(&state.client_pool, payload, limit).await?;

    if new_klines.is_empty() {
        warn!("⚠️ [API EMPTY] Returned 0 candles for {}", primary_key);
        return Ok(Some(0));
    }

    // ✨✨✨ 核心逻辑：注入数据到 Room，让 WebSocket 的 tx 数据立即可用 ✨✨✨
    // 1. 计算 Room Name (需要和 socket_handlers.rs 逻辑一致)
    let chain_lower = payload.chain.to_lowercase();
    let pool_id = match chain_lower.as_str() {
        "bsc" => 14,
        "sol" | "solana" => 16,
        "base" => 199,
        _ => 0, // 这种情况下通常不会走到这里，或者在 socket handler 就拦截了
    };
    
    if pool_id != 0 {
        let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
        
        // 2. 查找房间并注入
        if let Some(room) = state.app_state.get(&room_name) {
             if let Some(last_candle) = new_klines.last() {
                 let mut lock = room.current_kline.lock().await;
                 // 只有当它是 None 时才注入（避免覆盖了可能已经到达的 WS kl 数据）
                 // 或者：强制注入也没问题，因为 HTTP 的数据是 "snapshot"，通常很新
                 // 为了保险，我们只在 None 时注入，因为如果它不是 None，说明 WS 已经正常工作了
                 if lock.is_none() {
                     *lock = Some(last_candle.clone());
                     info!("💉 [INJECT] Successfully injected HTTP candle into WebSocket state for {}", room_name);
                 }
             }
        }
    }

    // 立即发送给前端
    let emit_start = Instant::now();
    let completed_response = KlineHistoryResponse {
        address: payload.address.clone(),
        chain: payload.chain.clone(),
        interval: payload.interval.clone(),
        data: new_klines.clone(),
    };

    if let Err(e) = s.emit("historical_kline_completed", &completed_response) {
        error!("❌ [EMIT ERROR] completed for {}: {}", primary_key, e);
    } else {
        // info!("🚀 [PERF EMIT] Data sent to client in {:?} (Before DB write)", emit_start.elapsed());
    }

    // 异步存库
    save_klines_to_db(&state.db_pool, primary_key, &new_klines).await?;
    prune_old_klines_from_db(&state.db_pool, primary_key).await?;

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

    for attempt in 1..=3 {
        let (client_idx, client) = pool.get_client().await;
        
        let http_start = Instant::now();

        match client.get(&url).send().await {
            Ok(response) => {
                info!("⚡ [PERF HTTP] Request took {:?}", http_start.elapsed());
                
                if !response.status().is_success() {
                     warn!("❌ [API FAIL] Status: {}. Recycling node #{}...", response.status(), client_idx);
                     pool.recycle_client(client_idx).await;
                     continue;
                }
                
                let text_response = response.text().await?;
                match serde_json::from_str::<HistoricalDataWrapper>(&text_response) {
                    Ok(wrapper) => {
                        match parse_api_data(&wrapper.data, &interval_label) {
                            Ok(data) => {
                                return Ok(data);
                            },
                            Err(e) => {
                                return Err(anyhow!("Data parse error: {}", e));
                            }
                        }
                    }
                    Err(e) => {
                        warn!("❌ [JSON PARSE FAIL] Error: {}. Recycling node #{}", e, client_idx);
                        pool.recycle_client(client_idx).await;
                    }
                }
            },
            Err(e) => {
                warn!("❌ [NET FAIL] Error: {}. Recycling node #{} and retrying...", e, client_idx);
                pool.recycle_client(client_idx).await;
            }
        }
    }

    Err(anyhow!("All 3 attempts failed."))
}

async fn get_klines_from_db(pool: &SqlitePool, primary_key: &str) -> Result<Vec<KlineTick>> {
    sqlx::query_as::<_, KlineTick>(
        "SELECT time, open, high, low, close, volume FROM klines WHERE primary_key = ? ORDER BY time ASC",
    )
    .bind(primary_key)
    .fetch_all(pool)
    .await
    .context("Failed to fetch all klines from DB")
}

async fn get_last_kline_from_db(pool: &SqlitePool, primary_key: &str) -> Result<Option<KlineTick>> {
    sqlx::query_as(
        "SELECT time, open, high, low, close, volume FROM klines WHERE primary_key = ? ORDER BY time DESC LIMIT 1",
    )
    .bind(primary_key)
    .fetch_optional(pool)
    .await
    .context("Failed to fetch last kline from DB")
}

async fn save_klines_to_db(
    pool: &SqlitePool,
    primary_key: &str,
    klines: &[KlineTick],
) -> Result<()> {
    if klines.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    for kline in klines {
        sqlx::query(
            "INSERT OR REPLACE INTO klines (primary_key, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(primary_key)
        .bind(kline.time.timestamp())
        .bind(kline.open)
        .bind(kline.high)
        .bind(kline.low)
        .bind(kline.close)
        .bind(kline.volume)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit()
        .await
        .context("Failed to commit transaction for saving klines")
}

async fn clear_klines_from_db(pool: &SqlitePool, primary_key: &str) -> Result<()> {
    sqlx::query("DELETE FROM klines WHERE primary_key = ?")
        .bind(primary_key)
        .execute(pool)
        .await?;
    Ok(())
}

async fn prune_old_klines_from_db(pool: &SqlitePool, primary_key: &str) -> Result<()> {
    let count: i64 = sqlx::query("SELECT COUNT(*) FROM klines WHERE primary_key = ?")
        .bind(primary_key)
        .fetch_one(pool)
        .await?
        .get(0);

    if count > DB_MAX_RECORDS {
        let limit = count - DB_PRUNE_TO_COUNT;
        sqlx::query(
            "DELETE FROM klines WHERE rowid IN (
                SELECT rowid FROM klines WHERE primary_key = ? ORDER BY time ASC LIMIT ?
            )",
        )
        .bind(primary_key)
        .bind(limit)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn get_primary_key(payload: &KlineSubscribePayload) -> String {
    format!(
        "{}@{}@{}",
        payload.address.to_lowercase(),
        payload.chain.to_lowercase(),
        payload.interval
    )
}

fn interval_to_ms(interval: &str) -> i64 {
    let value_str: String = interval.chars().take_while(|c| c.is_ascii_digit()).collect();
    let unit: String = interval.chars().skip_while(|c| c.is_ascii_digit()).collect();
    let value = value_str.parse::<i64>().unwrap_or(0);
    match unit.as_str() {
        "m" => Duration::minutes(value).num_milliseconds(),
        "h" => Duration::hours(value).num_milliseconds(),
        "d" => Duration::days(value).num_milliseconds(),
        _ => 0,
    }
}

fn format_interval_for_api(interval: &str) -> String {
    if let Some(val) = interval.strip_suffix('m') {
        format!("{}min", val)
    } else {
        interval.to_string()
    }
}

fn parse_api_data(data: &[Vec<Value>], interval_label: &str) -> Result<Vec<KlineTick>> {
    let extract_f64 = |v: &Value, name: &str| -> Result<f64> {
        if let Some(f) = v.as_f64() {
            return Ok(f);
        }
        if let Some(s) = v.as_str() {
            return s.parse::<f64>().map_err(|_| {
                anyhow!("Invalid float string for {}: {}", name, s)
            });
        }
        if let Some(i) = v.as_i64() {
            return Ok(i as f64);
        }
        Ok(0.0)
    };

    data.iter()
        .map(|d| -> Result<KlineTick> {
            let timestamp_ms = d.get(5).and_then(|v| v.as_i64()).unwrap_or(0);
            Ok(KlineTick {
                time: DateTime::from_timestamp(timestamp_ms / 1000, 0)
                    .context("Invalid timestamp")?
                    .with_timezone(&Utc),
                open: extract_f64(d.get(0).unwrap_or(&Value::Null), "open")?,
                high: extract_f64(d.get(1).unwrap_or(&Value::Null), "high")?,
                low: extract_f64(d.get(2).unwrap_or(&Value::Null), "low")?,
                close: extract_f64(d.get(3).unwrap_or(&Value::Null), "close")?,
                volume: extract_f64(d.get(4).unwrap_or(&Value::Null), "volume")?,
            })
        })
        .collect()
}

impl sqlx::FromRow<'_, SqliteRow> for KlineTick {
    fn from_row(row: &SqliteRow) -> sqlx::Result<Self> {
        let timestamp_secs: i64 = row.try_get("time")?;
        Ok(KlineTick {
            time: DateTime::from_timestamp(timestamp_secs, 0)
                .unwrap_or_default()
                .with_timezone(&Utc),
            open: row.try_get("open")?,
            high: row.try_get("high")?,
            low: row.try_get("low")?,
            close: row.try_get("close")?,
            volume: row.try_get("volume")?,
        })
    }
}