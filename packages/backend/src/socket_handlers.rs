// packages/backend/src/socket_handlers.rs

use super::{
    binance_task,
    kline_handler,
    types::{DataPayload, KlineSubscribePayload, Room, KlineTick, MemeItem, NarrativeResponse},
    ServerState,
};
use socketioxide::{
    extract::{Data, SocketRef},
};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn, debug};

const MIN_HOTLIST_AMOUNT: f64 = 1.0;
const NARRATIVE_API_URL: &str = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/token/ai/narrative/query";

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
            async move { kline_handler::handle_kline_request(s, payload, state).await; }
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
                                log_summary = format!("🔥 [HOTLIST] Act: {:?} | Filter: {} -> {}", r#type, original_count, filtered_count);
                                for item in data.iter() {
                                    state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone());
                                }
                            },
                            DataPayload::MemeNew { r#type, data } => {
                                data.retain(|item| !item.symbol.is_empty());
                                
                                // ✨ 核心逻辑：获取 Narrative
                                let fetch_start = std::time::Instant::now();
                                enrich_meme_data(data, &state).await;
                                let fetch_duration = fetch_start.elapsed();

                                let filtered_count = data.len();
                                should_broadcast = !data.is_empty();
                                log_summary = format!(
                                    "🐶 [MEME RUSH] Act: {:?} | Items: {} | Enriched in {:.2?}", 
                                    r#type, filtered_count, fetch_duration
                                );

                                for item in data.iter() {
                                    state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone());
                                }
                            },
                            DataPayload::Unknown => {
                                warn!("⚠️ [DATA] Received unknown category payload.");
                            }
                        }

                        if should_broadcast {
                            info!("{}", log_summary);
                            if let Err(e) = s.broadcast().emit("data-broadcast", &parsed_payload).await {
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

// ✨ 增强了日志的 enrich 函数
async fn enrich_meme_data(items: &mut Vec<MemeItem>, state: &ServerState) {
    let mut indices_to_fetch = Vec::new();
    
    // 1. 快速检查缓存，找出需要请求的项
    for (i, item) in items.iter().enumerate() {
        if state.narrative_cache.contains_key(&item.contract_address) {
            continue; // 已缓存
        }
        indices_to_fetch.push(i);
    }

    if !indices_to_fetch.is_empty() {
        info!("🔍 [NARRATIVE] Found {} items missing description. Fetching...", indices_to_fetch.len());
    }

    // 2. 串行请求 (为了简化和调试，先串行，避免并发问题)
    for idx in indices_to_fetch {
        let item = &mut items[idx];
        let address = item.contract_address.clone();
        let chain = item.chain.clone();
        let client_pool = state.client_pool.clone();
        let cache = state.narrative_cache.clone();

        if let Some(chain_id) = get_chain_id(&chain) {
            info!("🌍 [FETCH START] {} ({}) -> ChainId: {}", item.symbol, address, chain_id);
            match fetch_narrative(&client_pool, &address, chain_id).await {
                Ok(Some(text)) => {
                    info!("✅ [FETCH SUCCESS] {}: {:.20}...", item.symbol, text);
                    cache.insert(address.clone(), text.clone());
                },
                Ok(None) => {
                    info!("📭 [FETCH EMPTY] {} has no narrative.", item.symbol);
                    // 缓存空字符串防止重复请求
                    cache.insert(address.clone(), "".to_string());
                },
                Err(e) => {
                    warn!("❌ [FETCH ERROR] {} failed: {}", item.symbol, e);
                }
            }
        } else {
            warn!("⚠️ [SKIP] Unsupported chain for narrative: {}", chain);
            // 标记为不支持，防止重复处理
             cache.insert(address.clone(), "".to_string());
        }
    }

    // 3. 统一填充 (从缓存)
    let mut enriched_count = 0;
    for item in items.iter_mut() {
        if let Some(text) = state.narrative_cache.get(&item.contract_address) {
            if !text.is_empty() {
                item.narrative = Some(text.clone());
                enriched_count += 1;
            }
        }
    }
    
    if enriched_count > 0 {
        debug!("📝 [NARRATIVE] Filled {}/{} items with narrative.", enriched_count, items.len());
    }
}

async fn fetch_narrative(pool: &crate::client_pool::ClientPool, address: &str, chain_id: u64) -> anyhow::Result<Option<String>> {
    let url = format!("{}?contractAddress={}&chainId={}", NARRATIVE_API_URL, address, chain_id);
    let (_, client) = pool.get_client().await;

    // 记录正在请求的 URL，方便调试
    debug!("🔗 Requesting: {}", url);

    let resp = client.get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Origin", "https://web3.binance.com") // 许多 API 需要 Origin
        .send()
        .await?;

    if !resp.status().is_success() {
        warn!("❌ API returned status: {}", resp.status());
        return Ok(None);
    }

    // 先读成文本，万一 JSON 解析失败可以看到原文
    let raw_body = resp.text().await?;
    // debug!("📦 Raw API Response: {}", raw_body); // 调试时可以打开，太长了先注释

    let body: NarrativeResponse = serde_json::from_str(&raw_body)?;

    if let Some(data) = body.data {
        if let Some(text_obj) = data.text {
            if let Some(cn) = text_obj.cn {
                if !cn.is_empty() { return Ok(Some(cn)); }
            }
            if let Some(en) = text_obj.en {
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
        "sol" | "solana" => None, // Binance API 通常不支持 Solana 的 Narrative (视具体接口而定，先关掉)
        _ => None,
    }
}

// ... (其余 register 函数保持不变)
fn register_kline_subscribe_handler(socket: &SocketRef, state: ServerState) {
    socket.on("subscribe_kline", move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
        let state = state.clone();
        async move {
            let chain_lower = payload.chain.to_lowercase();
            let address_lowercase = payload.address.to_lowercase();
            let symbol = state.token_symbols.get(&address_lowercase).map_or_else(|| format!("{}...", &payload.address[0..6]), |s| s.value().clone());
            let pool_id = match chain_lower.as_str() { "bsc" => 14, "sol" | "solana" => 16, "base" => 199, _ => return };
            let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
            let log_display_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);
            info!("🔔 [SUB] Client {} -> Room: {}", s.id, log_display_name);
            s.join(room_name.clone());
            state.app_state.entry(room_name.clone()).or_insert_with(|| {
                info!("✨ [ROOM NEW] First subscriber for '{}'. Spawning Binance task...", log_display_name);
                let current_kline = Arc::new(Mutex::new(None::<KlineTick>));
                let task_handle = tokio::spawn(binance_task::binance_websocket_task(state.io.clone(), room_name.clone(), symbol.clone(), state.config.clone(), current_kline.clone()));
                Room { clients: HashSet::new(), task_handle, symbol, current_kline }
            }).value_mut().clients.insert(s.id);
        }
    });
}

fn register_kline_unsubscribe_handler(socket: &SocketRef, state: ServerState) {
    socket.on("unsubscribe_kline", move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
        let state = state.clone();
        async move {
            let chain_lower = payload.chain.to_lowercase();
            let pool_id = match chain_lower.as_str() { "bsc" => 14, "sol" | "solana" => 16, "base" => 199, _ => return };
            let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
            info!("🔽 [UNSUB] Client {} leaving room", s.id);
            s.leave(room_name.clone());
            if let Some(mut room) = state.app_state.get_mut(&room_name) {
                room.clients.remove(&s.id);
                if room.clients.is_empty() {
                    drop(room);
                    if let Some((_, room_to_abort)) = state.app_state.remove(&room_name) {
                        room_to_abort.task_handle.abort();
                    }
                }
            }
        }
    });
}

fn register_disconnect_handler(socket: &SocketRef, state: ServerState) {
    socket.on_disconnect(move |s: SocketRef| {
        let state = state.clone();
        async move {
            let mut empty_rooms: Vec<String> = Vec::new();
            for mut entry in state.app_state.iter_mut() {
                if entry.value_mut().clients.remove(&s.id) && entry.clients.is_empty() {
                    empty_rooms.push(entry.key().clone());
                }
            }
            for room_name in empty_rooms {
                if let Some((_, room)) = state.app_state.remove(&room_name) {
                    room.task_handle.abort();
                }
            }
        }
    });
}