use crate::config::Config;
use crate::state::{AppState, RoomIndex, SubscriptionCommand};
use crate::types::{
    BinanceKlineDataWrapper, BinanceStreamWrapper, BinanceTickDataWrapper, KlineBroadcastData,
    KlineTick,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use futures_util::{stream::SplitSink, SinkExt, StreamExt};
use socketioxide::SocketIo;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::{interval, sleep, Duration};
use tokio_native_tls::TlsStream;
use tokio_tungstenite::{
    client_async_with_config,
    tungstenite::{client::IntoClientRequest, Message},
    WebSocketStream,
};
use tracing::{error, info, warn};
use url::Url;

// Reuse helper functions from binance_task (will be made public later)
use crate::binance_task::{establish_http_tunnel, wrap_stream_with_tls};

type WsStream = WebSocketStream<TlsStream<TcpStream>>;
type WsWrite = SplitSink<WsStream, Message>;

const LOW_VOLUME_PRICE_DEVIATION_THRESHOLD: f64 = 2.0;
const LOW_VOLUME_THRESHOLD: f64 = 10.0;

/// 🟢 Token Worker: Manages a single WebSocket connection for ONE token (Address)
/// Subscribes to BOTH Kline (specific intervals) AND Ticket (realtime trades)
pub async fn start_token_worker(
    token_address: String,
    pool_id: i64,
    io: SocketIo,
    config: Arc<Config>,
    app_state: AppState,
    room_index: RoomIndex,
    mut cmd_rx: UnboundedReceiver<SubscriptionCommand>,
) {
    let worker_id = format!("WORKER[{}]", token_address);
    info!("🚀 [{}] Starting...", worker_id);

    let mut active_intervals: HashSet<String> = HashSet::new();
    let mut is_tick_subscribed = false;

    loop {
        // Connect loop
        let result = connect_and_serve(
            &worker_id,
            &token_address,
            pool_id,
            &io,
            &config,
            &app_state,
            &room_index,
            &mut cmd_rx,
            &mut active_intervals,
            &mut is_tick_subscribed,
        )
        .await;

        match result {
            Ok(should_exit) => {
                if should_exit {
                    info!("👋 [{}] Shutdown gracefully.", worker_id);
                    break;
                }
                warn!("🔁 [{}] Disconnected. Reconnecting in 3s...", worker_id);
            }
            Err(e) => {
                error!("💥 [{}] Crash: {:#?}. Retrying in 5s...", worker_id, e);
            }
        }
        sleep(Duration::from_secs(3)).await;
    }
}

async fn connect_and_serve(
    worker_id: &str,
    token_address: &str,
    pool_id: i64,
    io: &SocketIo,
    config: &Config,
    app_state: &AppState,
    room_index: &RoomIndex,
    cmd_rx: &mut UnboundedReceiver<SubscriptionCommand>,
    active_intervals: &mut HashSet<String>,
    is_tick_subscribed: &mut bool,
) -> Result<bool> {
    // 1. Establish Connection
    let stream = establish_http_tunnel(worker_id, config).await?;
    let host = Url::parse(&config.binance_wss_url)?
        .host_str()
        .unwrap_or_default()
        .to_string();
    let tls_stream = wrap_stream_with_tls(stream, &host).await?;

    let mut request = config.binance_wss_url.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("User-Agent", "Rust/Backend TokenWorker".parse()?);

    let (ws_stream, _) = client_async_with_config(request, tls_stream, None)
        .await
        .context("Handshake failed")?;

    info!("✅ [{}] Connected!", worker_id);

    let (mut write, mut read) = ws_stream.split();

    // 2. Resubscribe logic (if reusing state)
    let mut streams_to_sub = Vec::new();
    
    // Always subscribe to tick for this token (optimistic) or wait for command?
    // Plan: Subscribe tick immediately as it's usually needed.
    // Actually, let's wait for commands to drive everything to be precise.
    // BUT, if we are reconnecting, we must resubscribe to what we had.
    
    if *is_tick_subscribed {
        streams_to_sub.push(format!("tx@{}_{}", pool_id, token_address));
    }
    
    for interval in active_intervals.iter() {
         streams_to_sub.push(format!("kl@{}@{}@{}", pool_id, token_address, interval));
    }

    if !streams_to_sub.is_empty() {
        info!("🔄 [{}] Resubscribing {} streams...", worker_id, streams_to_sub.len());
        send_subscribe(&mut write, streams_to_sub).await?;
    }

    let mut heartbeat = interval(config.heartbeat_interval);
    heartbeat.tick().await;

    // 3. Event Loop
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                write.send(Message::Ping(vec![].into())).await?;
            }

            // Command Handling
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(command) => {
                        match command {
                            SubscriptionCommand::Subscribe(raw_stream) => {
                                // raw_stream expected formats:
                                // kl@poolId_addr_interval or tx@poolId_addr
                                
                                if raw_stream.starts_with("tx@") {
                                    if !*is_tick_subscribed {
                                        *is_tick_subscribed = true;
                                        send_subscribe(&mut write, vec![raw_stream]).await?;
                                    }
                                } else if raw_stream.starts_with("kl@") {
                                    // Extract interval
                                    let parts: Vec<&str> = raw_stream.split('@').collect();
                                    if let Some(interval) = parts.last() {
                                        if !active_intervals.contains(*interval) {
                                            active_intervals.insert(interval.to_string());
                                            send_subscribe(&mut write, vec![raw_stream]).await?;
                                        }
                                    }
                                } else if raw_stream == "SHUTDOWN" {
                                    return Ok(true); // Exit signal
                                }
                            },
                            SubscriptionCommand::Unsubscribe(raw_stream) => {
                                if raw_stream.starts_with("tx@") {
                                    if *is_tick_subscribed {
                                        *is_tick_subscribed = false;
                                        send_unsubscribe(&mut write, vec![raw_stream]).await?;
                                    }
                                } else if raw_stream.starts_with("kl@") {
                                    let parts: Vec<&str> = raw_stream.split('_').collect();
                                    if let Some(interval) = parts.last() {
                                        if active_intervals.contains(*interval) {
                                            active_intervals.remove(*interval);
                                            send_unsubscribe(&mut write, vec![raw_stream]).await?;
                                        }
                                    }
                                }
                                
                                // Auto-shutdown Check
                                if !*is_tick_subscribed && active_intervals.is_empty() {
                                    info!("💤 [{}] No active subs. Idle shutdown.", worker_id);
                                    return Ok(true);
                                }
                            }
                        }
                    },
                    None => return Ok(true), // Channel closed
                }
            }

            // WebSocket Message Handling
            msg_result = read.next() => {
                match msg_result {
                    Some(Ok(msg)) => {
                        match msg {
                            Message::Text(text) => handle_payload(&worker_id, &text, io, app_state, room_index).await,
                            Message::Ping(p) => { write.send(Message::Pong(p)).await?; }
                            Message::Close(_) => return Ok(false), // Reconnect
                            _ => {}
                        }
                    },
                    Some(Err(e)) => return Err(e.into()),
                    None => return Ok(false), // EOF -> Reconnect
                }
            }
        }
    }
}

async fn send_subscribe(write: &mut WsWrite, params: Vec<String>) -> Result<()> {
    info!("📡 [WS-OUT] Subscribing: {:?}", params);
    let msg = serde_json::json!({
        "method": "SUBSCRIBE",
        "params": params,
        "id": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis()
    });
    write.send(Message::Text(msg.to_string().into())).await?;
    Ok(())
}

async fn send_unsubscribe(write: &mut WsWrite, params: Vec<String>) -> Result<()> {
    let msg = serde_json::json!({
        "method": "UNSUBSCRIBE",
        "params": params,
        "id": SystemTime::now().duration_since(SystemTime::UNIX_EPOCH)?.as_millis()
    });
    write.send(Message::Text(msg.to_string().into())).await?;
    Ok(())
}

async fn handle_payload(
    _worker_id: &str,
    text: &str,
    io: &SocketIo,
    app_state: &AppState,
    room_index: &RoomIndex,
) {
    if text.contains("\"result\":null") { return; }

    // Try parsing as Kline first
    if let Ok(wrapper) = serde_json::from_str::<BinanceStreamWrapper<BinanceKlineDataWrapper>>(text) {
         // stream: kl@poolID@address@interval (使用@作为分隔符)
         let parts: Vec<&str> = wrapper.stream.split('@').collect();
         if parts.len() == 4 {
             // parts[0] = "kl", parts[1] = poolId, parts[2] = address, parts[3] = interval
             let pool_id = parts[1];
             let address = parts[2];
             let interval = parts[3];
             // room_key 格式与内部一致
             let room_key = format!("kl@{}@{}@{}", pool_id, address, interval);
             let kline = parse_kline(&wrapper.data.kline_data.values);
             
             // Update & Broadcast
             if let Some(room) = app_state.get(&room_key) {
                 *room.current_kline.lock().await = Some(kline.clone());
                 let bca = KlineBroadcastData { room: room_key.clone(), data: kline };
                 io.to(room_key).emit("kline_update", &bca).await.ok();
             }
         }
         return;
    }

    // Try parsing as Tick
    if let Ok(wrapper) = serde_json::from_str::<BinanceStreamWrapper<BinanceTickDataWrapper>>(text) {
        let tick = &wrapper.data.tick_data;
        let parts: Vec<&str> = wrapper.stream.split('@').collect();
        if parts.len() == 2 {
            // parts[1] example: "16_address"
            let params: Vec<&str> = parts[1].split('_').collect(); // [poolId, addr]
            if params.len() >= 2 {
                let tracked_address = params[1]; 
                
                // Debug log for received tick (sampled)
                if tick.v > 1000.0 { // 只打印大额或随机打印，防止刷屏，但为了调试先全部打印关键信息
                     info!("🔔 [TICK RECV] Stream: {} | Addr: {} | Price: {}", wrapper.stream, tracked_address, tick.t0pu);
                }

                // Price extraction
                let price = if tick.t0a.eq_ignore_ascii_case(tracked_address) { tick.t0pu } 
                            else if tick.t1a.eq_ignore_ascii_case(tracked_address) { tick.t1pu } 
                            else { 
                                warn!("⚠️ [TICK MISMATCH] Tracked: {} | T0: {} | T1: {}", tracked_address, tick.t0a, tick.t1a);
                                return; 
                            };
                
                let usd_volume = tick.v;

                // Broadcast 1: Update all Room Klines for this token
                // Use tracked_address directly (it respects case from subscription)
                if let Some(room_keys) = room_index.get(tracked_address) {
                    let mut broadcast_count = 0;
                    for room_key in room_keys.iter() {
                         if let Some(entry) = app_state.get(room_key) {
                             let mut kline_guard = entry.value().current_kline.lock().await;
                             if let Some(kline) = kline_guard.as_mut() {
                                 // Price Filter
                                 if kline.close > 0.0 {
                                     let ratio = if price > kline.close { price / kline.close } else { kline.close / price };
                                     if ratio > LOW_VOLUME_PRICE_DEVIATION_THRESHOLD && usd_volume < LOW_VOLUME_THRESHOLD {
                                         warn!("🛡️ [PRICE FILTER] Ignored anomaly: Price {} vs Last {}, Vol {}", price, kline.close, usd_volume);
                                         continue;
                                     }
                                 }
                                 kline.high = kline.high.max(price);
                                 kline.low = kline.low.min(price);
                                 kline.close = price;

                                 let bca = KlineBroadcastData { room: room_key.clone(), data: kline.clone() };
                                 io.to(room_key.clone()).emit("kline_update", &bca).await.ok();
                                 broadcast_count += 1;
                             }
                         }
                    }
                    if broadcast_count > 0 && tick.v > 5000.0 {
                         info!("📡 [BROADCAST] Sent update to {} rooms for {}", broadcast_count, tracked_address);
                    }
                } else {
                    warn!("⚠️ [NO ROOMS] Received tick for {} but no rooms found in index", tracked_address);
                }
            }
        }
    }
}

fn parse_kline(values: &(String, String, String, String, String, String)) -> KlineTick {
    KlineTick {
        time: DateTime::from_timestamp(values.5.parse::<i64>().unwrap_or_default() / 1000, 0)
            .unwrap_or_default()
            .with_timezone(&Utc),
        open: values.0.parse().unwrap_or_default(),
        high: values.1.parse().unwrap_or_default(),
        low: values.2.parse().unwrap_or_default(),
        close: values.3.parse().unwrap_or_default(),
        volume: values.4.parse().unwrap_or_default(),
    }
}
