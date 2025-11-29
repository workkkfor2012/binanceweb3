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
use tracing::{error, info, warn};

// ✨ 定义过滤阈值：1000 USD (成交量 * 价格)
// 仅用于 Hotlist，Meme 币不使用此阈值
const MIN_HOTLIST_AMOUNT: f64 = 1.0;

// ✨ Binance Narrative API URL
const NARRATIVE_API_URL: &str = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/token/ai/narrative/query";

// ✨ 本地代理地址 (解决 API 连接被阻断问题)
const PROXY_URL: &str = "http://127.0.0.1:1080";

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
                // 1. 尝试反序列化为 types.rs 中定义的 DataPayload 枚举
                match serde_json::from_value::<DataPayload>(payload.0) {
                    Ok(mut parsed_payload) => {
                        let mut should_broadcast = false;
                        let mut log_summary = String::new();

                        // 2. 核心分流逻辑：根据枚举类型分别处理
                        match &mut parsed_payload {
                            // ==========================================================
                            // 🟢 场景 A: 处理 Hotlist (常规热门币)
                            // ==========================================================
                            DataPayload::Hotlist { r#type, data } => {
                                let original_count = data.len();
                                
                                // ✨ Hotlist 专用逻辑: 执行金额过滤
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

                                // 更新 Symbol Map
                                for item in data.iter() {
                                    state.token_symbols.insert(
                                        item.contract_address.to_lowercase(), 
                                        item.symbol.clone()
                                    );
                                }
                            },

                            // ==========================================================
                            // 🔵 场景 B: 处理 MemeNew (新币/土狗)
                            // ==========================================================
                            DataPayload::MemeNew { r#type, data } => {
                                // ✨ Meme 专用逻辑:
                                data.retain(|item| !item.symbol.is_empty());

                                // ✨✨✨ 核心逻辑：获取项目描述 (Narrative) ✨✨✨
                                enrich_meme_data(data, &state).await;

                                let filtered_count = data.len();
                                should_broadcast = !data.is_empty();
                                log_summary = format!(
                                    "🐶 [MEME RUSH] Act: {:?} | Items: {} | Narrative Check Done", 
                                    r#type, 
                                    filtered_count
                                );

                                // 更新 Symbol Map
                                for item in data.iter() {
                                    state.token_symbols.insert(
                                        item.contract_address.to_lowercase(), 
                                        item.symbol.clone()
                                    );
                                }
                            },

                            // ⚪ 其他/未知
                            DataPayload::Unknown => {
                                warn!("⚠️ [DATA] Received unknown category payload.");
                            }
                        }

                        // 3. 广播数据 (如果还有剩余数据)
                        if should_broadcast {
                            info!("{}", log_summary);
                            // socketioxide 会自动序列化 DataPayload 枚举
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

// ✨✨✨ 辅助函数：批量填充 Meme 数据的描述信息 ✨✨✨
// 修复 1: 使用 PENDING 状态防止重复请求
// 修复 2: 使用随机/线性延迟错峰请求，防止触发 WAF
// 修复 3: 使用 PROXY 解决网络连接问题
async fn enrich_meme_data(items: &mut Vec<MemeItem>, state: &ServerState) {
    let mut indices_to_fetch = Vec::new();

    // 1. 快速检查缓存，找出需要请求的项
    for (i, item) in items.iter().enumerate() {
        // 如果缓存里有 key（无论是真正的内容，还是 "__PENDING__"），都跳过请求
        if state.narrative_cache.contains_key(&item.contract_address) {
            continue; 
        }
        
        // 关键点：立即占位！防止后续的高频 Update 再次触发请求
        state.narrative_cache.insert(item.contract_address.clone(), "__PENDING__".to_string());
        indices_to_fetch.push(i);
    }

    if !indices_to_fetch.is_empty() {
        info!("🔍 [NARRATIVE] Queuing fetch for {} NEW items (staggered with proxy).", indices_to_fetch.len());
    }

    // 2. 执行请求 (异步 Spawn，不阻塞 Socket 广播)
    // 错峰请求：每隔 200ms 发一个，防止瞬间把代理打挂或被目标 API 封锁
    for (queue_idx, &item_idx) in indices_to_fetch.iter().enumerate() {
        let address = items[item_idx].contract_address.clone();
        let chain = items[item_idx].chain.clone();
        // let client_pool = state.client_pool.clone(); // 🔴 不使用全局池，改用独立的代理 Client
        let cache = state.narrative_cache.clone();

        // 延迟递增
        let delay = std::time::Duration::from_millis(queue_idx as u64 * 200);

        if let Some(chain_id) = get_chain_id(&chain) {
            tokio::spawn(async move {
                // 等待轮到自己
                tokio::time::sleep(delay).await;

                // 开始请求 (传入 None 表示不使用 Pool，而是内部新建代理连接)
                match fetch_narrative(&address, chain_id).await {
                    Ok(Some(text)) => {
                        info!("✅ [FETCH SUCCESS] For {}: {:.20}...", address, text);
                        cache.insert(address, text);
                    },
                    Ok(None) => {
                        // info!("📭 [FETCH EMPTY] For {}.", address);
                        cache.insert(address, "".to_string()); // 标记为空，防止重复请求
                    },
                    Err(e) => {
                        warn!("❌ [FETCH ERROR] For {}: {}", address, e);
                        // 出错后移除 PENDING 状态，允许未来重试
                        cache.remove(&address); 
                    }
                }
            });
        } else {
            // 不支持的链，标记为空，不再尝试
            cache.insert(address, "".to_string());
        }
    }

    // 3. 统一填充 (从缓存读取内容给前端)
    for item in items.iter_mut() {
        if let Some(text) = state.narrative_cache.get(&item.contract_address) {
            if !text.is_empty() && text.as_str() != "__PENDING__" {
                item.narrative = Some(text.clone());
            }
        }
    }
}

// ✨ 修改：不再依赖全局 ClientPool，而是创建一个带 Proxy 的专用 Client
async fn fetch_narrative(address: &str, chain_id: u64) -> anyhow::Result<Option<String>> {
    let url = format!("{}?contractAddress={}&chainId={}", NARRATIVE_API_URL, address, chain_id);

    // 1. 配置代理
    let proxy = reqwest::Proxy::all(PROXY_URL)?;

    // 2. 构建专用 Client (ClientBuilder 没有 .header 方法，需在 Request 中设置)
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    // 3. 发起请求 (在这里伪装成真实浏览器 Headers)
    let resp = client.get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept-Encoding", "gzip, deflate, br")
        .header("ClientType", "web")
        .header("ClientVersion", "1.0.0")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .header("Origin", "https://web3.binance.com")
        .header("Referer", "https://web3.binance.com/zh-CN/meme-rush")
        .header("Sec-Ch-Ua", "\"Google Chrome\";v=\"125\", \"Chromium\";v=\"125\", \"Not.A/Brand\";v=\"24\"")
        .header("Sec-Ch-Ua-Mobile", "?0")
        .header("Sec-Ch-Ua-Platform", "\"Windows\"")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .send()
        .await?;

    if !resp.status().is_success() {
        warn!("❌ [API FAIL] Status: {} | URL: {}", resp.status(), url);
        return Ok(None);
    }

    let body: NarrativeResponse = resp.json().await?;

    if let Some(data) = body.data {
        if let Some(text_obj) = data.text {
            // 优先使用中文，其次英文
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
        "sol" | "solana" => None, // Binance 暂不支持 Solana Narrative
        _ => None, // 不支持的链跳过 fetch
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

                // 尝试从缓存中获取 Symbol，如果没有则截断地址显示
                let symbol = state.token_symbols
                    .get(&address_lowercase)
                    .map_or_else(
                        || format!("{}...", &payload.address[0..6]),
                        |s| s.value().clone()
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

                // 初始化房间逻辑 (启动 Binance 任务)
                state.app_state
                    .entry(room_name.clone())
                    .or_insert_with(|| {
                        info!("✨ [ROOM NEW] First subscriber for '{}'. Spawning Binance task...", log_display_name);
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
                // let address_lowercase = payload.address.to_lowercase(); // 未使用

                let symbol = state.token_symbols
                    .get(&payload.address.to_lowercase())
                    .map_or_else(|| format!("{}...", &payload.address[0..6]), |s| s.value().clone());

                let pool_id = match chain_lower.as_str() {
                    "bsc" => 14, 
                    "sol" | "solana" => 16, 
                    "base" => 199,
                    _ => { return; }
                };
                let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
                let log_display_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);

                info!("🔽 [UNSUB] Client {} leaving room: {}", s.id, log_display_name);
                s.leave(room_name.clone());

                // 检查房间是否为空，为空则清理任务
                if let Some(mut room) = state.app_state.get_mut(&room_name) {
                    room.clients.remove(&s.id);
                    if room.clients.is_empty() {
                        drop(room);
                        if let Some((_, room_to_abort)) = state.app_state.remove(&room_name) {
                            info!("🗑️ [ROOM EMPTY] Last client left '{}'. Aborting Binance task.", log_display_name);
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
            // info!("🔌 [Socket.IO] Client disconnected: {}", s.id);
            let mut empty_rooms: Vec<(String, String)> = Vec::new();

            for mut entry in state.app_state.iter_mut() {
                if entry.value_mut().clients.remove(&s.id) {
                    let log_display_name = {
                        let parts: Vec<&str> = entry.key().split('@').collect();
                        if parts.len() == 4 {
                             format!("{}@{}@{}@{}", parts[0], parts[1], &entry.value().symbol, parts[3])
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
                    info!("🗑️ [ROOM CLEANUP] Room '{}' is now empty. Aborting task.", log_display_name);
                    room.task_handle.abort();
                }
            }
        }
    });
}