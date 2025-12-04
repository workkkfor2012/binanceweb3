// packages/backend/src/socket_handlers.rs
use super::{
    kline_handler,
    state::SubscriptionCommand,
    types::{DataPayload, KlineSubscribePayload, KlineTick, MemeItem, NarrativeResponse, Room},
    ServerState,
};
use socketioxide::extract::{Data, SocketRef};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::Duration;
use tracing::{error, info, warn};

const MIN_HOTLIST_AMOUNT: f64 = 1.0;
const NARRATIVE_API_URL: &str = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/token/ai/narrative/query";
const LAZY_UNSUBSCRIBE_DELAY: u64 = 60;

pub async fn on_socket_connect(s: SocketRef, state: ServerState) {
    info!("🔌 [Socket.IO] Client connected: {}", s.id);
    register_data_update_handler(&s, state.clone());
    register_kline_subscribe_handler(&s, state.clone());
    register_kline_unsubscribe_handler(&s, state.clone());
    register_disconnect_handler(&s, state.clone());
    register_kline_history_handler(&s, state);
}

// ✨ 辅助：处理索引增加 (返回是否是第一次订阅该地址)
fn handle_index_subscription(state: &ServerState, address: &str, room_key: &str) -> bool {
    let address_lower = address.to_lowercase();
    let mut entry = state.room_index.entry(address_lower).or_default();
    let is_first = entry.is_empty();
    entry.insert(room_key.to_string());
    is_first
}

// ✨ 辅助：处理索引减少 (返回该地址是否已经没有订阅者)
fn handle_index_unsubscription(state: &ServerState, address: &str, room_key: &str) -> bool {
    let address_lower = address.to_lowercase();
    if let Some(mut entry) = state.room_index.get_mut(&address_lower) {
        entry.remove(room_key);
        return entry.is_empty();
    }
    // 如果 key 不存在（应该不会发生），也视为无人订阅
    true
}

// ✨✨✨ 核心：Lazy Unsubscribe 调度器 ✨✨✨
fn schedule_lazy_tick_unsubscribe(state: ServerState, address: String, pool_id: i64) {
    tokio::spawn(async move {
        let address_lower = address.to_lowercase();
        // 1. 等待缓冲期
        tokio::time::sleep(Duration::from_secs(LAZY_UNSUBSCRIBE_DELAY)).await;

        // 2. 再次检查索引状态 (Double Check)
        let should_really_unsub = if let Some(entry) = state.room_index.get(&address_lower) {
            entry.is_empty() // 只有集合为空，才说明期间无人加入
        } else {
            true // Key 都不在了
        };

        // 3. 执行真正的退订
        if should_really_unsub {
            info!("📤 [LAZY EXEC] Timer ended. No subscribers for {}. Unsubscribing Tick.", address);
            let tx_stream = format!("tx@{}_{}", pool_id, address);
            let _ = state.binance_channels.tick_tx.send(SubscriptionCommand::Unsubscribe(tx_stream));
            
            // ✨ 修复：清理空的 Index Key 防止内存泄漏
            state.room_index.remove(&address_lower);
        } else {
            info!("♻️ [LAZY ABORT] Timer ended. User rejoined {}. Keeping connection alive.", address);
        }
    });
}

fn register_kline_subscribe_handler(socket: &SocketRef, state: ServerState) {
    socket.on("subscribe_kline", move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
        let state = state.clone();
        async move {
            let chain_lower = payload.chain.to_lowercase();
            let address_lower = payload.address.to_lowercase();
            
            // 简单获取 Symbol 作为日志显示
            let symbol = state.token_symbols.get(&address_lower).map_or_else(
                || format!("{}...", &payload.address[0..6]),
                |s| s.value().clone(),
            );

            let pool_id = match chain_lower.as_str() {
                "bsc" => 14,
                "sol" | "solana" => 16,
                "base" => 199,
                _ => return,
            };

            let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
            let log_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);

            info!("🔔 [SUB] Client {} -> {}", s.id, log_name);
            s.join(room_name.clone());

            let is_new_room = !state.app_state.contains_key(&room_name);

            // 1. AppState 更新
            state.app_state.entry(room_name.clone())
                .or_insert_with(|| Room {
                    clients: HashSet::new(),
                    symbol: symbol.clone(),
                    current_kline: Arc::new(Mutex::new(None)),
                })
                .value_mut().clients.insert(s.id);

            // 2. 索引更新
            let need_sub_tick = handle_index_subscription(&state, &payload.address, &room_name);

            if is_new_room {
                // K线流：立即订阅
                let kl_stream = format!("kl@{}_{}_{}", pool_id, payload.address, payload.interval);
                let _ = state.binance_channels.kline_tx.send(SubscriptionCommand::Subscribe(kl_stream));

                // Tick流：如果是该 Token 的第一个订阅者，立即订阅
                if need_sub_tick {
                    info!("📤 [SUB TICK] First sub for {}, sending Global CMD.", payload.address);
                    let tx_stream = format!("tx@{}_{}", pool_id, payload.address);
                    let _ = state.binance_channels.tick_tx.send(SubscriptionCommand::Subscribe(tx_stream));
                }
            }
        }
    });
}

fn register_kline_unsubscribe_handler(socket: &SocketRef, state: ServerState) {
    socket.on("unsubscribe_kline", move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
        let state = state.clone();
        async move {
            let pool_id = match payload.chain.to_lowercase().as_str() {
                "bsc" => 14, "sol" | "solana" => 16, "base" => 199, _ => return,
            };
            let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);

            s.leave(room_name.clone());

            let mut room_empty = false;
            if let Some(mut room) = state.app_state.get_mut(&room_name) {
                room.clients.remove(&s.id);
                room_empty = room.clients.is_empty();
            }

            if room_empty {
                state.app_state.remove(&room_name);
                // 1. K线流：立即退订
                let kl_stream = format!("kl@{}_{}_{}", pool_id, payload.address, payload.interval);
                let _ = state.binance_channels.kline_tx.send(SubscriptionCommand::Unsubscribe(kl_stream));

                // 2. Tick流：触发 Lazy Unsubscribe
                if handle_index_unsubscription(&state, &payload.address, &room_name) {
                    info!("⏳ [LAZY START] No subscribers for {}. Scheduling unsub in {}s...", payload.address, LAZY_UNSUBSCRIBE_DELAY);
                    schedule_lazy_tick_unsubscribe(state.clone(), payload.address.clone(), pool_id);
                }
            }
        }
    });
}

fn register_disconnect_handler(socket: &SocketRef, state: ServerState) {
    socket.on_disconnect(move |s: SocketRef| {
        let state = state.clone();
        async move {
            let mut empty_rooms = Vec::new();
            for mut entry in state.app_state.iter_mut() {
                if entry.value_mut().clients.remove(&s.id) && entry.value().clients.is_empty() {
                    empty_rooms.push(entry.key().clone());
                }
            }

            for room_name in empty_rooms {
                if let Some(_) = state.app_state.remove(&room_name) {
                    let parts: Vec<&str> = room_name.split('@').collect();
                    if parts.len() == 4 {
                        let pool_id = parts[1].parse::<i64>().unwrap_or(0);
                        let address = parts[2].to_string();
                        let interval = parts[3];

                        let kl_stream = format!("kl@{}_{}_{}", pool_id, address, interval);
                        let _ = state.binance_channels.kline_tx.send(SubscriptionCommand::Unsubscribe(kl_stream));

                        if handle_index_unsubscription(&state, &address, &room_name) {
                            schedule_lazy_tick_unsubscribe(state.clone(), address, pool_id);
                        }
                    }
                }
            }
        }
    });
}

fn register_kline_history_handler(socket: &SocketRef, state: ServerState) {
    socket.on("request_historical_kline", move |s: SocketRef, payload: Data<KlineSubscribePayload>| {
        let state = state.clone();
        async move { kline_handler::handle_kline_request(s, payload, state).await; }
    });
}

fn register_data_update_handler(socket: &SocketRef, state: ServerState) {
    socket.on("data-update", move |s: SocketRef, payload: Data<serde_json::Value>| {
        let state = state.clone();
        async move {
            match serde_json::from_value::<DataPayload>(payload.0) {
                Ok(mut parsed_payload) => {
                    let mut should_broadcast = false;
                    let mut log_summary = String::new();

                    match &mut parsed_payload {
                        DataPayload::Hotlist { r#type, data } => {
                            data.retain(|item| (item.volume1h.unwrap_or(0.0) * item.price.unwrap_or(0.0)) >= MIN_HOTLIST_AMOUNT);
                            should_broadcast = !data.is_empty();
                            log_summary = format!("🔥 [HOTLIST] Act: {:?} | Count: {}", r#type, data.len());
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                        }
                        DataPayload::MemeNew { r#type, data } => {
                            data.retain(|item| !item.symbol.is_empty());
                            enrich_meme_data(data, &state).await;
                            should_broadcast = !data.is_empty();
                            log_summary = format!("🐶 [MEME RUSH] Act: {:?} | Count: {}", r#type, data.len());
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                        }
                        DataPayload::MemeMigrated { r#type, data } => {
                            data.retain(|item| !item.symbol.is_empty());
                            enrich_meme_data(data, &state).await;
                            should_broadcast = !data.is_empty();
                            log_summary = format!("🚀 [MEME MIGRATED] Act: {:?} | Count: {}", r#type, data.len());
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                        }
                        _ => {}
                    }

                    if should_broadcast {
                        info!("{}", log_summary);
                        s.broadcast().emit("data-broadcast", &parsed_payload).await.ok();
                    }
                }
                Err(e) => warn!("❌ [JSON PARSE ERROR] {}", e),
            }
        }
    });
}

// ✨ 保留本地优秀的逻辑：使用 ClientPool 并传递 Client 引用
async fn enrich_meme_data(items: &mut Vec<MemeItem>, state: &ServerState) {
    let mut to_fetch = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if !state.narrative_cache.contains_key(&item.contract_address) {
            state.narrative_cache.insert(item.contract_address.clone(), "__PENDING__".to_string());
            to_fetch.push(i);
        }
    }

    for (q_idx, &idx) in to_fetch.iter().enumerate() {
        let addr = items[idx].contract_address.clone();
        let chain = items[idx].chain.clone();
        let cache = state.narrative_cache.clone();
        let proxy_pool = state.narrative_proxy_pool.clone();
        let delay = std::time::Duration::from_millis(q_idx as u64 * 250);

        if let Some(cid) = get_chain_id(&chain) {
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let (client_idx, client) = proxy_pool.get_client().await;
                
                match fetch_narrative(&client, &addr, cid).await {
                    Ok(Some(t)) => {
                        info!("✅ [Fetch OK] {}: {:.15}...", addr, t);
                        cache.insert(addr, t);
                    }
                    Ok(None) => { cache.insert(addr, "".into()); }
                    Err(e) => {
                        warn!("❌ [Fetch ERR] Client #{} failed for {}: {}. Recycling...", client_idx, addr, e);
                        proxy_pool.recycle_client(client_idx).await;
                        cache.remove(&addr);
                    }
                }
            });
        } else {
            cache.insert(addr, "".into());
        }
    }

    for item in items.iter_mut() {
        if let Some(t) = state.narrative_cache.get(&item.contract_address) {
            if !t.is_empty() && t.as_str() != "__PENDING__" {
                item.narrative = Some(t.clone());
            }
        }
    }
}

async fn fetch_narrative(client: &reqwest::Client, address: &str, chain_id: u64) -> anyhow::Result<Option<String>> {
    let url = format!("{}?contractAddress={}&chainId={}", NARRATIVE_API_URL, address, chain_id);
    let resp = client.get(&url)
        .header("ClientType", "web")
        .header("Origin", "https://web3.binance.com")
        .header("Referer", "https://web3.binance.com/zh-CN/meme-rush")
        .header("Sec-Ch-Ua", "\"Google Chrome\";v=\"125\", \"Chromium\";v=\"125\", \"Not.A/Brand\";v=\"24\"")
        .header("Sec-Ch-Ua-Mobile", "?0")
        .header("Sec-Ch-Ua-Platform", "\"Windows\"")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .send().await?;

    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("HTTP Status {}", resp.status()));
    }
    let body: NarrativeResponse = resp.json().await?;
    if let Some(d) = body.data {
        if let Some(t) = d.text {
            if let Some(cn) = t.cn { if !cn.is_empty() { return Ok(Some(cn)); } }
            if let Some(en) = t.en { if !en.is_empty() { return Ok(Some(en)); } }
        }
    }
    Ok(None)
}

fn get_chain_id(chain: &str) -> Option<u64> {
    match chain.to_lowercase().as_str() {
        "bsc" => Some(56), "eth" | "ethereum" => Some(1), "base" => Some(8453),
        "arb" | "arbitrum" => Some(42161), "matic" | "polygon" => Some(137),
        "op" | "optimism" => Some(10), "avax" | "avalanche" => Some(43114),
        _ => None,
    }
}