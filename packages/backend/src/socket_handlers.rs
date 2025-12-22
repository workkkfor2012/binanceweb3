// packages/backend/src/socket_handlers.rs
use super::{
    kline_handler,
    state::SubscriptionCommand,
    // ✨ 引入新的 Struct 和 Trait
    types::{DataPayload, KlineSubscribePayload, NarrativeEntity, NarrativeResponse, Room, AlertLogEntry, AlertType, HotlistItem},
    ServerState,
};
use socketioxide::extract::{Data, SocketRef};
use socketioxide::SocketIo;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::Duration;
use tracing::{info, warn, error}; // ✨ Added error
use chrono::Utc;
use flate2::read::GzDecoder;
use std::io::Read;
use uuid::Uuid;

const MIN_HOTLIST_AMOUNT: f64 = 10000.0;
const NARRATIVE_API_URL: &str = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/token/ai/narrative/query";
const LAZY_UNSUBSCRIBE_DELAY: u64 = 60;

// ============== 报警阈值配置 ==============
const ALERT_VOLUME_1M_USD: f64 = 50.0;
const ALERT_VOLUME_5M_USD: f64 = 200.0;
const ALERT_PRICE_CHANGE_1M_PERCENT: f64 = 5.0;
const ALERT_PRICE_CHANGE_5M_PERCENT: f64 = 25.0;
const ALERT_PRICE_CHANGE_1M_MIN_VOLUME_USD: f64 = 20.0;  // 价格异动需满足的最小成交额
const ALERT_PRICE_CHANGE_5M_MIN_VOLUME_USD: f64 = 100.0;
const ALERT_COOLDOWN_MS: i64 = 60_000; // 1 分钟冷却
const MAX_ALERT_HISTORY: usize = 50;
// Helper to normalize address based on chain/pool_id
// EVM (BSC/ETH/Base) -> Lowercase
// Solana (PoolId 16) -> Case Sensitive (Keep Original)
pub fn normalize_address(pool_id: i64, address: &str) -> String {
    if pool_id == 16 {
        address.to_string()
    } else {
        address.to_lowercase()
    }
}

pub async fn on_socket_connect(s: SocketRef, state: ServerState) {
    info!("🔌 [Socket.IO] Client connected: {}", s.id);

    // 🔥 新增：推送报警历史给新连接的客户端
    {
        let history = state.alert_history.lock().await;
        // VecDeque -> Vec
        let history_vec: Vec<_> = history.iter().cloned().collect();
        if !history_vec.is_empty() {
            s.emit("alert_history", &history_vec).ok();
            info!("📜 [Alert] Sent {} historical alerts to {}", history_vec.len(), s.id);
        }
    }

    register_data_update_handler(&s, state.clone());
    register_kline_subscribe_handler(&s, state.clone());
    register_kline_unsubscribe_handler(&s, state.clone());
    register_disconnect_handler(&s, state.clone());
    register_kline_history_handler(&s, state);
}



fn handle_index_subscription(state: &ServerState, normalized_address: &str, room_key: &str) -> bool {
    let mut entry = state.room_index.entry(normalized_address.to_string()).or_default();
    let is_first = entry.is_empty();
    entry.insert(room_key.to_string());
    is_first
}

fn handle_index_unsubscription(state: &ServerState, normalized_address: &str, room_key: &str) -> bool {
    if let Some(mut entry) = state.room_index.get_mut(normalized_address) {
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
            // 1. Calculate pool_id FIRST to determine normalization rule
            let pool_id = match chain_lower.as_str() {
                "bsc" => 14, "sol" | "solana" => 16, "base" => 199, _ => return,
            };

            // 2. Normalize Address (Preserve case for SOL, lowercase for EVM)
            let address = normalize_address(pool_id, &payload.address);
            
            let symbol = state.token_symbols.get(&address).map_or_else(
                || format!("{}...", &address[0..6]),
                |s| s.value().clone(),
            );

            let room_name = format!("kl@{}@{}@{}", pool_id, address, payload.interval);
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

            let need_sub_tick = handle_index_subscription(&state, &address, &room_name);

            if is_new_room {
                // 1. Ensure TokenWorker exists (Use normalized address as key)
                if !state.token_managers.contains_key(&address) {
                    info!("🛠️ [WORKER SPAWN] Creating new TokenWorker for: {}", address); // ✨ Debug Log
                    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                    state.token_managers.insert(address.clone(), tx);
                    
                    let state_clone = state.clone();
                    let address_clone = address.clone();
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
                } else {
                    info!("♻️ [WORKER REUSE] TokenWorker already exists for: {}", address); // ✨ Debug Log
                }
                
                // 2. Send Subscribe Command
                if let Some(sender) = state.token_managers.get(&address) {
                    let kl_stream = format!("kl@{}@{}@{}", pool_id, address, payload.interval);
                    info!("📤 [CMD SEND] Subscribe Kline: {}", kl_stream); // ✨ Debug Log
                    if let Err(e) = sender.send(SubscriptionCommand::Subscribe(kl_stream)) {
                        error!("❌ [CMD FAIL] Failed to send Kline sub command: {}", e);
                    }
                    
                    if need_sub_tick {
                        let tx_stream = format!("tx@{}_{}", pool_id, address);
                        info!("📤 [CMD SEND] Subscribe Tick: {}", tx_stream); // ✨ Debug Log
                        if let Err(e) = sender.send(SubscriptionCommand::Subscribe(tx_stream)) {
                             error!("❌ [CMD FAIL] Failed to send Tick sub command: {}", e);
                        }
                    }
                }
            } else {
                info!("✋ [SUB SKIP] Room {} already exists, assuming worker subscribed.", room_name); // ✨ Debug Log
            }
        }
    });
}

fn register_kline_unsubscribe_handler(socket: &SocketRef, state: ServerState) {
    socket.on("unsubscribe_kline", move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
        let state = state.clone();
        async move {
            // 1. Calculate pool_id FIRST
            let pool_id = match payload.chain.to_lowercase().as_str() {
                "bsc" => 14, "sol" | "solana" => 16, "base" => 199, _ => return,
            };

            // 2. Normalize Address
            let address = normalize_address(pool_id, &payload.address);
            
            // 3. Construct keys (Use Normalized Address)
            let room_name = format!("kl@{}@{}@{}", pool_id, address, payload.interval);

            s.leave(room_name.clone());

            let mut room_empty = false;
            // Remove from app_state
            if let Some(mut room) = state.app_state.get_mut(&room_name) {
                room.clients.remove(&s.id);
                room_empty = room.clients.is_empty();
            }

            if room_empty {
                state.app_state.remove(&room_name);
                let kl_stream = format!("kl@{}@{}@{}", pool_id, address, payload.interval);
                
                if let Some(sender) = state.token_managers.get(&address) {
                    let _ = sender.send(SubscriptionCommand::Unsubscribe(kl_stream));
                }

                if handle_index_unsubscription(&state, &address, &room_name) {
                    info!("⏳ [LAZY START] No subscribers for {}. Scheduling unsub in {}s...", address, LAZY_UNSUBSCRIBE_DELAY);
                    schedule_lazy_tick_unsubscribe(state.clone(), address, pool_id);
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
                        let address = parts[2].to_string(); // Already normalized in room key
                        let interval = parts[3];

                        let kl_stream = format!("kl@{}@{}@{}", pool_id, address, interval);
                         if let Some(sender) = state.token_managers.get(&address) {
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
                            let now = Utc::now().timestamp_millis();
                            let thirty_mins_ms = 60 * 60 * 1000;
                            data.retain(|item| {
                                let amount_ok = (item.volume24h.unwrap_or(0.0) * item.price.unwrap_or(0.0)) >= MIN_HOTLIST_AMOUNT;
                                let time_ok = match item.create_time {
                                    Some(ct) => (now - ct) >= thirty_mins_ms,
                                    None => true, // 如果没传创建时间，默认保留
                                };
                                amount_ok && time_ok
                            });
                            should_broadcast = !data.is_empty();
                            //log_summary = format!("🔥 [HOTLIST] Act: {:?} | Count: {}", r#type, data.len());
                            
                            // 记录 Symbol 映射
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                            
                            // 🔥 Hotlist 不需要 Narrative，直接跳过
                            // enrich_any_data(data, &state).await;
                            
                            // 🔥 新增：报警检测
                            check_and_trigger_alerts(data, &state, &state.io).await;
                            should_broadcast = !data.is_empty();  // 再判断一次，虽然通常 check 不会修改 data
                        }
                        
                        // 2. 处理 New Meme (MemeScanItem 结构体)
                        DataPayload::MemeNew { r#type: _, data } => {
                            data.retain(|item| !item.symbol.is_empty());
                            
                            
                            // 🔥 Debug Logic: 打印收到的 Meme 完整信息
                            // for item in data.iter() {
                            //     info!("📦 [MemeNew Received] Detailed Item: {:?}", item);
                            // }

                            // 🔥 调用泛型 Enrich 函数 (MemeScanItem 实现了 NarrativeEntity)
                            enrich_any_data(data, &state).await;
                            
                            should_broadcast = !data.is_empty();
                            //log_summary = format!("🐶 [MEME RUSH] Act: {:?} | Count: {}", r#type, data.len());
                            for item in data.iter() { state.token_symbols.insert(item.contract_address.to_lowercase(), item.symbol.clone()); }
                        }
                        
                        // 3. 处理 Migrated Meme (MemeScanItem 结构体)
                        DataPayload::MemeMigrated { r#type: _, data } => {
                            data.retain(|item| !item.symbol.is_empty());
                            
                            
                            // 🔥 Debug Logic: 打印收到的 MemeMigrated 完整信息
                            // for item in data.iter() {
                            //     info!("🚀 [MemeMigrated Received] Detailed Item: {:?}", item);
                            // }

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

        // 1. 确定 ChainID 
        // 优先使用 narrative_chain_id (如 CT_501)
        // 如果没有，尝试使用旧的映射 (bsc -> 56)
        let specific_cid = items[idx].get_narrative_chain_id();
        let final_cid = if let Some(id) = specific_cid {
            Some(id)
        } else {
            get_chain_id(&chain).map(|id| id.to_string())
        };

        if let Some(cid) = final_cid {
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let (client_idx, client) = proxy_pool.get_client().await;
                
                match fetch_narrative(&client, &addr, &cid).await {
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

async fn fetch_narrative(client: &reqwest::Client, address: &str, chain_id: &str) -> anyhow::Result<Option<String>> {
    let url = format!("{}?contractAddress={}&chainId={}", NARRATIVE_API_URL, address, chain_id);
    info!("🔗 [Narrative Req] URL: {}", url);
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

async fn check_and_trigger_alerts(
    items: &[HotlistItem],
    state: &ServerState,
    io: &SocketIo,
) {
    let now = Utc::now().timestamp_millis();
    for item in items {
        let chain = &item.chain;
        let addr = &item.contract_address;
        let symbol = &item.symbol;
        let price = item.price.unwrap_or(0.0);
        
        // 计算成交额 (原始数据是 volume，需乘以价格得到 USD)
        let volume_1m_usd = item.volume1m.unwrap_or(0.0) * price;
        let volume_5m_usd = item.volume5m.unwrap_or(0.0) * price;

        // --- 规则 1: 1 分钟成交额 ---
        if volume_1m_usd > ALERT_VOLUME_1M_USD {
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::Volume1m,
                format!("{} 1分钟 {}美金", symbol, volume_1m_usd.round() as i64),
                now,
            ).await;
        }

        // --- 规则 2: 5 分钟成交额 ---
        if volume_5m_usd > ALERT_VOLUME_5M_USD {
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::Volume5m,
                format!("{} 5分钟 {}美金", symbol, volume_5m_usd.round() as i64),
                now,
            ).await;
        }

        // --- 规则 3: 1 分钟涨跌幅 (需满足最小成交额) ---
        let pc_1m = item.price_change1m.unwrap_or(0.0);
        if pc_1m.abs() > ALERT_PRICE_CHANGE_1M_PERCENT
            && volume_1m_usd > ALERT_PRICE_CHANGE_1M_MIN_VOLUME_USD
        {
            let direction = if pc_1m > 0.0 { "上涨" } else { "下跌" };
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::PriceChange1m,
                format!("{} 1分钟{}{:.1}%", symbol, direction, pc_1m.abs()),
                now,
            ).await;
        }

        // --- 规则 4: 5 分钟涨跌幅 (需满足最小成交额) ---
        let pc_5m = item.price_change5m.unwrap_or(0.0);
        if pc_5m.abs() > ALERT_PRICE_CHANGE_5M_PERCENT
            && volume_5m_usd > ALERT_PRICE_CHANGE_5M_MIN_VOLUME_USD
        {
            let direction = if pc_5m > 0.0 { "上涨" } else { "下跌" };
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::PriceChange5m,
                format!("{} 5分钟{}{:.1}%", symbol, direction, pc_5m.abs()),
                now,
            ).await;
        }
    }
}

async fn try_trigger_alert(
    state: &ServerState,
    io: &SocketIo,
    chain: &str,
    addr: &str,
    symbol: &str,
    alert_type: AlertType,
    message: String,
    now: i64,
) {
    let type_str = match alert_type {
        AlertType::Volume1m => "volume1m",
        AlertType::Volume5m => "volume5m",
        AlertType::PriceChange1m => "priceChange1m",
        AlertType::PriceChange5m => "priceChange5m",
    };
    
    let cooldown_key = format!("{}:{}:{}", chain, addr.to_lowercase(), type_str);

    // 检查冷却
    let should_alert = {
        if let Some(last_time) = state.alert_cooldowns.get(&cooldown_key) {
            now - *last_time > ALERT_COOLDOWN_MS
        } else {
            true
        }
    };

    if !should_alert {
        return;
    }

    // 更新冷却
    state.alert_cooldowns.insert(cooldown_key, now);

    // 创建日志条目
    let entry = AlertLogEntry {
        id: Uuid::new_v4().to_string(),
        chain: chain.to_string(),
        contract_address: addr.to_string(),
        symbol: symbol.to_string(),
        message: message.clone(),
        timestamp: now,
        alert_type: alert_type.clone(),
    };

    // 更新历史队列
    {
        let mut history = state.alert_history.lock().await;
        history.push_front(entry.clone());
        if history.len() > MAX_ALERT_HISTORY {
            history.pop_back();
        }
    }

    // 广播给所有订阅者
    info!("🚨 [Alert] Broadcasting: {}", message);
    io.emit("alert_update", &entry).await.ok();
}