// packages/backend/src/kline_handler.rs
use crate::{
    types::{HistoricalDataWrapper, KlineSubscribePayload, KlineTick},
    ServerState,
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde_json::Value;
use socketioxide::extract::{Data, SocketRef};
use sqlx::{
    sqlite::{SqlitePool, SqliteRow}, // 这个导入现在会生效
    Row,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_retry::{strategy::ExponentialBackoff, Retry};
use tracing::{error, info, warn};

// ... (文件余下内容保持不变) ...

const API_URL_TEMPLATE: &str = "https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval={interval}&limit={limit}&platform={platform}";
const API_MAX_LIMIT: i64 = 500;
const DB_MAX_RECORDS: i64 = 1000;
const DB_PRUNE_TO_COUNT: i64 = 500;
const FETCH_RETRY_COUNT: usize = 10;

static KLINE_FETCH_LOCKS: Lazy<DashMap<String, Arc<Mutex<()>>>> = Lazy::new(DashMap::new);

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
    let primary_key = get_primary_key(&payload);
    info!(
        "[KLINE_REQ] Received for {} from client {}",
        primary_key, s.id
    );

    let initial_data = match get_klines_from_db(&state.db_pool, &primary_key).await {
        Ok(data) => data,
        Err(e) => {
            error!(
                "[KLINE_DB_ERR] Failed to get initial klines for {}: {}",
                primary_key, e
            );
            vec![]
        }
    };
    
    if let Err(e) = s.emit("historical_kline_initial", &initial_data) {
        error!(
            "[KLINE_EMIT_ERR] Failed to send initial klines for {}: {}",
            primary_key, e
        );
    }

    tokio::spawn(async move {
        let lock = KLINE_FETCH_LOCKS
            .entry(primary_key.clone())
            .or_default()
            .clone();
        let Ok(_guard) = lock.try_lock() else {
            info!("[KLINE_FETCH_LOCK] Completion task for {} is already running. Skipping.", primary_key);
            return;
        };

        info!(
            "[KLINE_FETCH_TASK] Starting completion task for {}",
            primary_key
        );
        match complete_kline_data(&payload, &state, &primary_key).await {
            Ok(Some(completed_data)) => {
                if !completed_data.is_empty() {
                    if let Err(e) = s.emit("historical_kline_completed", &completed_data) {
                        error!(
                            "[KLINE_EMIT_ERR] Failed to send completed klines for {}: {}",
                            primary_key, e
                        );
                    }
                    info!(
                        "[KLINE_FETCH_TASK] Successfully completed and sent data for {}",
                        primary_key
                    );
                } else {
                    info!(
                        "[KLINE_FETCH_TASK] Task for {} finished, no new data to send.",
                        primary_key
                    );
                }
            }
            Ok(None) => {
                info!(
                    "[KLINE_FETCH_TASK] Task for {} finished, data was up to date.",
                    primary_key
                );
            }
            Err(e) => {
                error!("[KLINE_FETCH_TASK_ERR] for {}: {:?}", primary_key, e);
                let err_payload =
                    serde_json::json!({ "key": primary_key, "error": e.to_string() });
                if let Err(e_emit) = s.emit("kline_fetch_error", &err_payload) {
                    error!(
                        "[KLINE_EMIT_ERR] Failed to send fetch error for {}: {}",
                        primary_key, e_emit
                    );
                }
            }
        }
    });
}

async fn complete_kline_data(
    payload: &KlineSubscribePayload,
    state: &ServerState,
    primary_key: &str,
) -> Result<Option<Vec<KlineTick>>> {
    let last_kline = get_last_kline_from_db(&state.db_pool, primary_key).await?;
    let interval_ms = interval_to_ms(&payload.interval);

    let mut limit = match last_kline {
        Some(kline) => {
            let time_diff_ms = Utc::now().timestamp_millis() - kline.time.timestamp_millis();
            (time_diff_ms / interval_ms).max(1)
        }
        None => API_MAX_LIMIT,
    };

    if limit <= 1 {
        info!("[KLINE_CHECK] Data for {} is up to date.", primary_key);
        return Ok(None);
    }
    
    if limit > API_MAX_LIMIT {
        warn!(
            "[KLINE_STALE] Data for {} is too old (missing {} candles). Clearing cache.",
            primary_key, limit
        );
        clear_klines_from_db(&state.db_pool, primary_key).await?;
        limit = API_MAX_LIMIT;
    }

    info!(
        "[KLINE_FETCH] Fetching {} candles for {}",
        limit, primary_key
    );
    let new_klines = fetch_historical_data(payload, limit).await?;
    if new_klines.is_empty() {
        return Ok(Some(vec![]));
    }
    
    save_klines_to_db(&state.db_pool, primary_key, &new_klines).await?;
    prune_old_klines_from_db(&state.db_pool, primary_key).await?;
    
    Ok(Some(new_klines))
}


async fn fetch_historical_data(
    payload: &KlineSubscribePayload,
    limit: i64,
) -> Result<Vec<KlineTick>> {
    let retry_strategy = ExponentialBackoff::from_millis(500).take(FETCH_RETRY_COUNT);
    let client = Client::new();

    Retry::spawn(retry_strategy, || async {
        let url = API_URL_TEMPLATE
            .replace("{address}", &payload.address)
            .replace("{platform}", &payload.chain)
            .replace("{interval}", &format_interval_for_api(&payload.interval))
            .replace("{limit}", &limit.to_string());
        
        let response = client.get(&url).send().await.context("API request failed")?;
        if !response.status().is_success() {
            return Err(anyhow!("API returned non-success status: {}", response.status()));
        }
        let wrapper: HistoricalDataWrapper = response.json().await.context("Failed to parse API JSON response")?;
        parse_api_data(&wrapper.data)
    }).await
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

async fn save_klines_to_db(pool: &SqlitePool, primary_key: &str, klines: &[KlineTick]) -> Result<()> {
    if klines.is_empty() { return Ok(()); }
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
    tx.commit().await.context("Failed to commit transaction for saving klines")
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
        info!("[DB_PRUNE] Pruning {} old records for {}", limit, primary_key);
        sqlx::query(
            "DELETE FROM klines WHERE rowid IN (
                SELECT rowid FROM klines WHERE primary_key = ? ORDER BY time ASC LIMIT ?
            )"
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
        format!("{}in", val)
    } else {
        interval.to_string()
    }
}

fn parse_api_data(data: &[Vec<Value>]) -> Result<Vec<KlineTick>> {
    data.iter()
        .map(|d| -> Result<KlineTick> {
            Ok(KlineTick {
                 time: DateTime::from_timestamp(d[5].as_i64().unwrap_or(0) / 1000, 0)
                    .context("Invalid timestamp")?
                    .with_timezone(&Utc),
                open: d[0].as_str().unwrap_or("0").parse()?,
                high: d[1].as_str().unwrap_or("0").parse()?,
                low: d[2].as_str().unwrap_or("0").parse()?,
                close: d[3].as_str().unwrap_or("0").parse()?,
                volume: d[4].as_str().unwrap_or("0").parse()?,
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