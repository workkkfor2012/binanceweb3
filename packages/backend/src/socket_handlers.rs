// packages/backend/src/socket_handlers.rs
use super::{
    kline_handler,
    state::SubscriptionCommand,
    // ✨ 引入新的 Struct 和 Trait
    types::{DataPayload, KlineSubscribePayload, NarrativeEntity, NarrativeResponse, Room},
    ServerState,
};
use socketioxide::extract::{Data, SocketRef};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::Duration;
use tracing::{info, warn};
use flate2::read::GzDecoder;
use std::io::Read;

const MIN_HOTLIST_AMOUNT: f64 = 0.0001;
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



fn handle_index_subscription(state: &ServerState, address: &str, room_key: &str) -> bool {
    let address_lower = address.to_lowercase();
    let mut entry = state.room_index.entry(address_lower).or_default();
    let is_first = entry.is_empty();
    entry.insert(room_key.to_string());
    is_first
}

fn handle_index_unsubscription(state: &ServerState, address: &str, room_key: &str) -> bool {
    let address_lower = address.to_lowercase();
    if let Some(mut entry) = state.room_index.get_mut(&address_lower) {
        entry.remove(room_key);
        return entry.is_empty();
    }
    true
}

fn schedule_lazy_tick_unsubscribe(state: ServerState, address: String, pool_id: i64) {
    tokio::spawn(async move {
        let address_lower = address.to_lowercase();
        tokio::time::sleep(Duration::from_secs(LAZY_UNSUBSCRIBE_DELAY)).await;

        let should_really_unsub = if let Some(entry) = state.room_index.get(&address_lower) {
            entry.is_empty()
        } else {
            true
        };

        if should_really_unsub {
            info!("📤 [LAZY EXEC] Timer ended. No subscribers for {}. Unsubscribing Tick.", address);
            let tx_stream = format!("tx@{}_{}", pool_id, address);
            if let Some(sender) = state.token_managers.get(&address_lower) {
                 let _ = sender.send(SubscriptionCommand::Unsubscribe(tx_stream));
            }
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
            info!("🔔 [SUB DEBUG] Payload: address={}, chain={}, interval={}", payload.address, payload.chain, payload.interval);
            let chain_lower = payload.chain.to_lowercase();
            let address_lower = payload.address.to_lowercase();
            
            let symbol = state.token_symbols.get(&address_lower).map_or_else(
                || format!("{}...", &address_lower[0..6]),
                |s| s.value().clone(),
            );

            let pool_id = match chain_lower.as_str() {
                "bsc" => 14, "sol" | "solana" => 16, "base" => 199, _ => return,
            };

            let room_name = format!("kl@{}@{}@{}", pool_id, address_lower, payload.interval);
            let log_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);

            info!("🔔 [SUB] Client {} -> {}", s.id, log_name);
            s.join(room_name.clone());

            let is_new_room = !state.app_state.contains_key(&room_name);

            state.app_state.entry(room_name.clone())
                .or_insert_with(|| Room {
                    clients: HashSet::new(),
                    symbol: symbol.clone(),
                    current_kline: Arc::new(Mutex::new(None)),
                })
                .value_mut().clients.insert(s.id);

            let need_sub_tick = handle_index_subscription(&state, &address_lower, &room_name);

            if is_new_room {
                // 1. Ensure TokenWorker exists
                if !state.token_managers.contains_key(&address_lower) {
                    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                    state.token_managers.insert(address_lower.clone(), tx);
                    
                    let state_clone = state.clone();
                    let address_clone = address_lower.clone();
                    tokio::spawn(async move {
                         crate::token_manager::start_token_worker(
                             address_clone,
                             pool_id,
                             state_clone.io.clone(),
                             state_clone.config.clone(),
                             state_clone.app_state.clone(),
                             state_clone.room_index.clone(),
                             rx
                         ).await;
                    });
                }
                
                // 2. Send Subscribe Command
                if let Some(sender) = state.token_managers.get(&address_lower) {
                    let kl_stream = format!("kl@{}_{}_{}", pool_id, address_lower, payload.interval);
                    let _ = sender.send(SubscriptionCommand::Subscribe(kl_stream));
                    
                    if need_sub_tick {
                        let tx_stream = format!("tx@{}_{}", pool_id, address_lower);
                        let _ = sender.send(SubscriptionCommand::Subscribe(tx_stream));
                    }
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
            let address_lower = payload.address.to_lowercase();
            let room_name = format!("kl@{}@{}@{}", pool_id, address_lower, payload.interval);

            s.leave(room_name.clone());

            let mut room_empty = false;
            if let Some(mut room) = state.app_state.get_mut(&room_name) {
                room.clients.remove(&s.id);
                room_empty = room.clients.is_empty();
            }

            if room_empty {
                state.app_state.remove(&room_name);
                let kl_stream = format!("kl@{}_{}_{}", pool_id, address_lower, payload.interval);
                
                if let Some(sender) = state.token_managers.get(&address_lower) {
                    let _ = sender.send(SubscriptionCommand::Unsubscribe(kl_stream));
                }

                if handle_index_unsubscription(&state, &address_lower, &room_name) {
                    info!("⏳ [LAZY START] No subscribers for {}. Scheduling unsub in {}s...", address_lower, LAZY_UNSUBSCRIBE_DELAY);
                    schedule_lazy_tick_unsubscribe(state.clone(), address_lower, pool_id);
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
                         if let Some(sender) = state.token_managers.get(&address.to_lowercase()) {
                            let _ = sender.send(SubscriptionCommand::Unsubscribe(kl_stream));
                        }

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

// ✨✨✨ 核心更新：匹配新的 DataPayload 枚举 ✨✨✨
fn register_data_update_handler(socket: &SocketRef, state: ServerState) {
    socket.on("data-update", move |s: SocketRef, payload: Data<serde_json::Value>| {
        let state = state.clone();
        async move {
            match serde_json::from_value::<DataPayload>(payload.0) {
                Ok(mut parsed_payload) => {
                    let mut should_broadcast = false;
                    let log_summary = String::new();

                    match &mut parsed_payload {
                        // 1. 处理 Hotlist (HotlistItem 结构体)
                        DataPayload::Hotlist { r#type: _, data } => {
                            // 过滤逻辑
                            data.retain(|item| (item.volume1h.unwrap_or(0.0) * item.price.unwrap_or(0.0)) >= MIN_HOTLIST_AMOUNT);
                            should_broadcast = !data.is_empty();
                            //log_summary = format!("🔥 [HOTLIST] Act: {:?} | Count: {}", r#type, data.len());
                            
                            // 记录 Symbol 映射
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                            
                            // 🔥 调用泛型 Enrich 函数 (HotlistItem 实现了 NarrativeEntity)
                            enrich_any_data(data, &state).await; 
                        }
                        
                        // 2. 处理 New Meme (MemeScanItem 结构体)
                        DataPayload::MemeNew { r#type: _, data } => {
                            data.retain(|item| !item.symbol.is_empty());
                            
                            // 🔥 调用泛型 Enrich 函数 (MemeScanItem 实现了 NarrativeEntity)
                            enrich_any_data(data, &state).await;
                            
                            should_broadcast = !data.is_empty();
                            //log_summary = format!("🐶 [MEME RUSH] Act: {:?} | Count: {}", r#type, data.len());
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                        }
                        
                        // 3. 处理 Migrated Meme (MemeScanItem 结构体)
                        DataPayload::MemeMigrated { r#type: _, data } => {
                            data.retain(|item| !item.symbol.is_empty());
                            
                            // 🔥 调用泛型 Enrich 函数
                            enrich_any_data(data, &state).await;
                            
                            should_broadcast = !data.is_empty();
                            //log_summary = format!("🚀 [MEME MIGRATED] Act: {:?} | Count: {}", r#type, data.len());
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                        }
                        _ => {}
                    }

                    if should_broadcast {
                        if !log_summary.is_empty() {
                            info!("{}", log_summary);
                        }
                        s.broadcast().emit("data-broadcast", &parsed_payload).await.ok();
                    }
                }
                Err(e) => warn!("❌ [JSON PARSE ERROR] Payload mismatch: {}", e),
            }
        }
    });
}

// ✨✨✨ 泛型 Enrich 函数 ✨✨✨
// 使用 trait bound: T 必须实现 NarrativeEntity 且支持并发 (Send + Sync)
async fn enrich_any_data<T>(items: &mut Vec<T>, state: &ServerState) 
where T: NarrativeEntity + Send + Sync 
{
    let mut to_fetch = Vec::new();
    
    // 1. 扫描哪些需要抓取
    for (i, item) in items.iter().enumerate() {
        let addr = item.get_address().to_lowercase();
        // 如果缓存没有这个 key，标记为待抓取
        if !state.narrative_cache.contains_key(&addr) {
            state.narrative_cache.insert(addr, "__PENDING__".to_string());
            to_fetch.push(i);
        }
    }

    // 2. 发起抓取任务
    for (q_idx, &idx) in to_fetch.iter().enumerate() {
        let addr = items[idx].get_address().to_string(); // 复制一份 string 避免借用冲突
        let chain = items[idx].get_chain().to_string();
        let cache = state.narrative_cache.clone();
        let proxy_pool = state.narrative_proxy_pool.clone();
        
        // 错峰延时，避免瞬间打爆 API
        let delay = std::time::Duration::from_millis(q_idx as u64 * 250);

        if let Some(cid) = get_chain_id(&chain) {
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let (client_idx, client) = proxy_pool.get_client().await;
                
                match fetch_narrative(&client, &addr, cid).await {
                    Ok(Some(t)) => {
                        info!("✅ [Fetch OK] {}: {:.15}...", addr, t);
                        cache.insert(addr.to_lowercase(), t);
                    }
                    Ok(None) => { 
                        // 没数据也缓存空字符串，避免重复请求
                        cache.insert(addr.to_lowercase(), "".into()); 
                    }
                    Err(e) => {
                        warn!("❌ [Fetch ERR] Client #{} failed for {}: {}. Recycling...", client_idx, addr, e);
                        // 只有网络错误才回收连接并删除缓存 key (允许重试)
                        proxy_pool.recycle_client(client_idx).await;
                        cache.remove(&addr.to_lowercase());
                    }
                }
            });
        } else {
            cache.insert(addr.to_lowercase(), "".into());
        }
    }

    // 3. 回填数据 (从缓存中读取)
    for item in items.iter_mut() {
        let addr = item.get_address().to_lowercase();
        if let Some(t) = state.narrative_cache.get(&addr) {
            if !t.is_empty() && t.as_str() != "__PENDING__" {
                item.set_narrative(t.clone());
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

    let bytes = resp.bytes().await?;
    
    // 自动检测 Gzip Magin Number (1f 8b)
    let text_body = if bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b {
        let mut d = GzDecoder::new(&bytes[..]);
        let mut s = String::new();
        match d.read_to_string(&mut s) {
            Ok(_) => {
                // info!("✅ [Gzip Decompressed] {} bytes -> {} chars", bytes.len(), s.len());
                s
            },
            Err(e) => {
                warn!("❌ [Gzip Error] Failed to decompress for {}: {}", address, e);
                // 降级：如果解压失败，尝试直接当文本读
                String::from_utf8_lossy(&bytes).to_string()
            }
        }
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };

    let body: NarrativeResponse = match serde_json::from_str(&text_body) {
        Ok(b) => b,
        Err(e) => {
            warn!("❌ [JSON PARSE FAILED] Addr: {} | Err: {} | Body (first 100): {:.100}", address, e, text_body);
            return Err(e.into());
        }
    };

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