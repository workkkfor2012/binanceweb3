// packages/backend/src/socket_handlers.rs
use crate::binance_task;
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
const NARRATIVE_API_URL: &str =
    "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/token/ai/narrative/query";
const LAZY_UNSUBSCRIBE_DELAY: u64 = 60;

pub async fn on_socket_connect(s: SocketRef, state: ServerState) {
    info!("🔌 [Socket.IO] Client connected: {}", s.id);

    register_data_update_handler(&s, state.clone());
    register_kline_subscribe_handler(&s, state.clone());
    register_kline_unsubscribe_handler(&s, state.clone());
    register_disconnect_handler(&s, state.clone());
    register_kline_history_handler(&s, state);
}

fn register_kline_history_handler(socket: &SocketRef, state: ServerState) {
    socket.on(
        "request_historical_kline",
        move |s: SocketRef, payload: Data<KlineSubscribePayload>| {
            let state = state.clone();
            async move {
                kline_handler::handle_kline_request(s, payload, state).await;
            }
        },
    );
}

fn register_data_update_handler(socket: &SocketRef, state: ServerState) {
    socket.on(
        "data-update",
        move |s: SocketRef, payload: Data<serde_json::Value>| {
            let state = state.clone();
            async move {
                match serde_json::from_value::<DataPayload>(payload.0) {
                    Ok(mut parsed_payload) => {
                        let mut should_broadcast = false;
                        let mut log_summary = String::new();

                        match &mut parsed_payload {
                            DataPayload::Hotlist { r#type, data } => {
                                let original_count = data.len();
                                data.retain(|item| {
                                    let volume = item.volume1h.unwrap_or(0.0);
                                    let price = item.price.unwrap_or(0.0);
                                    let amount = volume * price;
                                    amount >= MIN_HOTLIST_AMOUNT
                                });
                                let filtered_count = data.len();
                                should_broadcast = !data.is_empty();
                                log_summary = format!(
                                    "🔥 [HOTLIST] Act: {:?} | Filter: {} -> {} (Criteria: 1H Amount >= ${})",
                                    r#type, original_count, filtered_count, MIN_HOTLIST_AMOUNT
                                );
                                for item in data.iter() {
                                    state.token_symbols.insert(
                                        item.contract_address.to_lowercase(),
                                        item.symbol.clone(),
                                    );
                                }
                            }
                            DataPayload::MemeNew { r#type, data } => {
                                data.retain(|item| !item.symbol.is_empty());
                                enrich_meme_data(data, &state).await;
                                let filtered_count = data.len();
                                should_broadcast = !data.is_empty();
                                log_summary = format!(
                                    "🐶 [MEME RUSH] Act: {:?} | Items: {} | Narrative Check Done",
                                    r#type, filtered_count
                                );
                                for item in data.iter() {
                                    state.token_symbols.insert(
                                        item.contract_address.to_lowercase(),
                                        item.symbol.clone(),
                                    );
                                }
                            }
                            DataPayload::MemeMigrated { r#type, data } => {
                                data.retain(|item| !item.symbol.is_empty());
                                enrich_meme_data(data, &state).await;
                                let filtered_count = data.len();
                                should_broadcast = !data.is_empty();
                                log_summary = format!(
                                    "🚀 [MEME MIGRATED] Act: {:?} | Items: {} | Narrative Check Done",
                                    r#type, filtered_count
                                );
                                for item in data.iter() {
                                    state.token_symbols.insert(
                                        item.contract_address.to_lowercase(),
                                        item.symbol.clone(),
                                    );
                                }
                            }
                            DataPayload::Unknown => {
                                warn!("⚠️ [DATA] Received unknown category payload.");
                            }
                        }

                        if should_broadcast {
                            info!("{}", log_summary);
                            if let Err(e) = s.broadcast().emit("data-broadcast", &parsed_payload).await
                            {
                                error!("❌ [BROADCAST FAIL] {:?}", e);
                            }
                        }
                    }
                    Err(e) => {
                        warn!("❌ [JSON PARSE ERROR] Failed to parse data-update: {}", e);
                    }
                }
            }
        },
    );
}

// ✨✨✨ 修复点：使用 narrative_proxy_pool 并且正确传递 Client ✨✨✨
async fn enrich_meme_data(items: &mut Vec<MemeItem>, state: &ServerState) {
    let mut to_fetch = Vec::new();
    
    for (i, item) in items.iter().enumerate() {
        if !state.narrative_cache.contains_key(&item.contract_address) {
            state
                .narrative_cache
                .insert(item.contract_address.clone(), "__PENDING__".to_string());
            to_fetch.push(i);
        }
    }

    if !to_fetch.is_empty() {
        info!("🔍 [NARRATIVE] Queuing fetch for {} items.", to_fetch.len());
    }

    for (q_idx, &idx) in to_fetch.iter().enumerate() {
        let addr = items[idx].contract_address.clone();
        let chain = items[idx].chain.clone();
        let cache = state.narrative_cache.clone();
        
        // 1. 获取代理池引用
        let proxy_pool = state.narrative_proxy_pool.clone();

        // 错峰请求
        let delay = std::time::Duration::from_millis(q_idx as u64 * 250);

        if let Some(cid) = get_chain_id(&chain) {
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;

                // 2. 从池中获取 Client 句柄
                let (client_idx, client) = proxy_pool.get_client().await;

                // 3. ⚠️ 关键修正：将 pool 中的 client 引用传递给 fetch 函数
                match fetch_narrative(&client, &addr, cid).await {
                    Ok(Some(t)) => {
                        info!("✅ [Fetch OK] {}: {:.15}...", addr, t);
                        cache.insert(addr, t);
                    }
                    Ok(None) => {
                        cache.insert(addr, "".into());
                    }
                    Err(e) => {
                        // 4. 触发熔断：请求失败，销毁并重建该 Client
                        warn!("❌ [Fetch ERR] Client #{} failed for {}: {}. Triggering Recycle...", client_idx, addr, e);
                        proxy_pool.recycle_client(client_idx).await;
                        cache.remove(&addr);
                    }
                }
            });
        } else {
            cache.insert(addr, "".into());
        }
    }

    // 填充数据回 item
    for item in items.iter_mut() {
        if let Some(t) = state.narrative_cache.get(&item.contract_address) {
            if !t.is_empty() && t.as_str() != "__PENDING__" {
                item.narrative = Some(t.clone());
            }
        }
    }
}

// ⚠️ 关键修正：移除任何内部 Client 构建逻辑，完全依赖外部注入
async fn fetch_narrative(
    client: &reqwest::Client,
    address: &str,
    chain_id: u64,
) -> anyhow::Result<Option<String>> {
    let url = format!(
        "{}?contractAddress={}&chainId={}",
        NARRATIVE_API_URL, address, chain_id
    );

    // 使用传入的 client 发送请求
    // 注意：Pool 中的 Client 已经配置了 Proxy, Timeout 和 User-Agent
    let resp = client.get(&url)
        .header("ClientType", "web")
        .header("Origin", "https://web3.binance.com")
        .header("Referer", "https://web3.binance.com/zh-CN/meme-rush")
        // 模拟真实浏览器指纹
        .header("Sec-Ch-Ua", "\"Google Chrome\";v=\"125\", \"Chromium\";v=\"125\", \"Not.A/Brand\";v=\"24\"")
        .header("Sec-Ch-Ua-Mobile", "?0")
        .header("Sec-Ch-Ua-Platform", "\"Windows\"")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(anyhow::anyhow!("HTTP Status {}", resp.status()));
    }

    let body: NarrativeResponse = resp.json().await?;

    if let Some(d) = body.data {
        if let Some(t) = d.text {
            if let Some(cn) = t.cn {
                if !cn.is_empty() { return Ok(Some(cn)); }
            }
            if let Some(en) = t.en {
                if !en.is_empty() { return Ok(Some(en)); }
            }
        }
    }
    Ok(None)
}

fn get_chain_id(chain: &str) -> Option<u64> {
    match chain.to_lowercase().as_str() {
        "bsc" => Some(56),
        "eth" | "ethereum" => Some(1),
        "base" => Some(8453),
        "arb" | "arbitrum" => Some(42161),
        "matic" | "polygon" => Some(137),
        "op" | "optimism" => Some(10),
        "avax" | "avalanche" => Some(43114),
        "sol" | "solana" => None,
        _ => None,
    }
}

fn register_kline_subscribe_handler(socket: &SocketRef, state: ServerState) {
    socket.on(
        "subscribe_kline",
        move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
            let state = state.clone();
            async move {
                let chain_lower = payload.chain.to_lowercase();
                let address_lowercase = payload.address.to_lowercase();

                let symbol = state.token_symbols.get(&address_lowercase).map_or_else(
                    || format!("{}...", &payload.address[0..6]),
                    |s| s.value().clone(),
                );

                let pool_id = match chain_lower.as_str() {
                    "bsc" => 14,
                    "sol" | "solana" => 16,
                    "base" => 199,
                    unsupported_chain => {
                        warn!("⚠️ [SUBSCRIBE FAIL] Unsupported chain '{}' (original: '{}') for {}. Ignored.", unsupported_chain, payload.chain, s.id);
                        return;
                    }
                };

                let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
                let log_display_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);

                info!("🔔 [SUB] Client {} -> Room: {}", s.id, log_display_name);
                s.join(room_name.clone());

                state
                    .app_state
                    .entry(room_name.clone())
                    .or_insert_with(|| {
                        info!(
                            "✨ [ROOM NEW] First subscriber for '{}'. Spawning Binance task...",
                            log_display_name
                        );
                        let current_kline = Arc::new(Mutex::new(None::<KlineTick>));

                        let task_handle = tokio::spawn(binance_task::binance_websocket_task(
                            state.io.clone(),
                            room_name.clone(),
                            symbol.clone(),
                            state.config.clone(),
                            current_kline.clone(),
                        ));

                        Room {
                            clients: HashSet::new(),
                            task_handle,
                            symbol,
                            current_kline,
                        }
                    })
                    .value_mut()
                    .clients
                    .insert(s.id);
            }
        },
    );
}

fn register_kline_unsubscribe_handler(socket: &SocketRef, state: ServerState) {
    socket.on(
        "unsubscribe_kline",
        move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
            let state = state.clone();
            async move {
                let chain_lower = payload.chain.to_lowercase();

                let symbol = state
                    .token_symbols
                    .get(&payload.address.to_lowercase())
                    .map_or_else(
                        || format!("{}...", &payload.address[0..6]),
                        |s| s.value().clone(),
                    );

                let pool_id = match chain_lower.as_str() {
                    "bsc" => 14,
                    "sol" | "solana" => 16,
                    "base" => 199,
                    _ => {
                        return;
                    }
                };
                let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
                let log_display_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);

                info!(
                    "🔽 [UNSUB] Client {} leaving room: {}",
                    s.id, log_display_name
                );
                s.leave(room_name.clone());

                if let Some(mut room) = state.app_state.get_mut(&room_name) {
                    room.clients.remove(&s.id);
                    if room.clients.is_empty() {
                        drop(room);
                        if let Some((_, room_to_abort)) = state.app_state.remove(&room_name) {
                            info!(
                                "🗑️ [ROOM EMPTY] Last client left '{}'. Aborting Binance task.",
                                log_display_name
                            );
                            room_to_abort.task_handle.abort();
                        }
                    }
                }
            }
        },
    );
}

fn register_disconnect_handler(socket: &SocketRef, state: ServerState) {
    socket.on_disconnect(move |s: SocketRef| {
        let state = state.clone();
        async move {
            let mut empty_rooms: Vec<(String, String)> = Vec::new();

            for mut entry in state.app_state.iter_mut() {
                if entry.value_mut().clients.remove(&s.id) {
                    let log_display_name = {
                        let parts: Vec<&str> = entry.key().split('@').collect();
                        if parts.len() == 4 {
                            format!(
                                "{}@{}@{}@{}",
                                parts[0],
                                parts[1],
                                &entry.value().symbol,
                                parts[3]
                            )
                        } else {
                            entry.key().to_string()
                        }
                    };
                    if entry.clients.is_empty() {
                        empty_rooms.push((entry.key().clone(), log_display_name));
                    }
                }
            }

            for (room_name, log_display_name) in empty_rooms {
                if let Some((_, room)) = state.app_state.remove(&room_name) {
                    info!(
                        "🗑️ [ROOM CLEANUP] Room '{}' is now empty. Aborting task.",
                        log_display_name
                    );
                    room.task_handle.abort();
                }
            }
        }
    });
}