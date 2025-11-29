// packages/backend/src/socket_handlers.rs

use super::{
    binance_task,
    kline_handler,
    types::{DataPayload, KlineSubscribePayload, Room, KlineTick},
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
const MIN_HOTLIST_AMOUNT: f64 = 1000.0;

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
                // Serde 会根据 JSON 中的 "category" 字段自动匹配是 Hotlist 还是 MemeNew
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
                                    // 注意：HotlistItem 才有 volume1h 字段
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

                                // 更新 Symbol Map (用于 K 线查询)
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
                                // let original_count = data.len();
                                
                                // ✨ Meme 专用逻辑: 
                                // 1. 不过滤金额 (新币通常没有多少成交量)
                                // 2. 可以添加简单的非空检查
                                data.retain(|item| !item.symbol.is_empty());

                                let filtered_count = data.len();
                                should_broadcast = !data.is_empty();
                                log_summary = format!(
                                    "🐶 [MEME RUSH] Act: {:?} | Items: {} (No Amount Filter)", 
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