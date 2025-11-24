// packages/backend/src/socket_handlers.rs


use super::{
    binance_task,
    kline_handler,
    types::{DataPayload, KlineSubscribePayload, Room, KlineTick, DataCategory},
    ServerState,
};
use socketioxide::{
    extract::{Data, SocketRef},
};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

// ✨ 定义过滤阈值：10万 (成交额 USD)
const MIN_HOTLIST_AMOUNT: f64 = 0.0000001;

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
                // ✨ 修改逻辑顺序：先解析 -> 再过滤 -> 最后广播

                match serde_json::from_value::<DataPayload>(payload.0) {
                    Ok(mut parsed_payload) => {
                        let original_count = parsed_payload.data.len();

                        // ✨ 核心过滤逻辑
                        // 如果是 Hotlist，则应用成交额过滤 (成交量 * 价格)
                        if parsed_payload.category == DataCategory::Hotlist {
                            parsed_payload.data.retain(|item| {
                                // ✨ 修改：使用 1小时成交量 (volume1h) 进行过滤
                                let volume = item.volume1h.unwrap_or(0.0);
                                let price = item.price.unwrap_or(0.0);
                                // 简单的成交量 * 价格 = 估算成交额 (Amount)
                                let amount = volume * price;
                                
                                // 日志记录极低成交量的数据（可选，用于调试）
                                // if amount < MIN_HOTLIST_AMOUNT {
                                //    info!("🔍 [FILTER DROP] {} (1H Vol: {}, Price: {}, Amount: {})", 
                                //        item.symbol.as_deref().unwrap_or("?"), volume, price, amount);
                                // }

                                amount >= 0.000000001
                            });
                        }

                        let filtered_count = parsed_payload.data.len();

                        // ✨ 更新日志：明确显示是基于 1H Amount 进行过滤
                        info!(
                            "🕷️ [SPIDER DATA] Cat: {:?} | Act: {:?} | Filter: {} -> {} (1H Amount >= {})", 
                            parsed_payload.category, 
                            parsed_payload.r#type,
                            original_count,
                            filtered_count,
                            MIN_HOTLIST_AMOUNT
                        );

                        // ✨ 只有当过滤后还有数据时，才广播给前端
                        if !parsed_payload.data.is_empty() {
                            // 这里直接广播处理过的 struct，socketioxide 会自动序列化它
                            if let Err(e) = s.broadcast().emit("data-broadcast", &parsed_payload).await {
                                error!("[Socket.IO] Failed to broadcast filtered data for {}: {:?}", s.id, e);
                            }
                        } else {
                           // info!("[FILTER] Dropped empty payload after filtering.");
                        }

                        // 更新 Symbol Map (使用过滤后的高质量数据)
                        match parsed_payload.category {
                            DataCategory::Unknown => {
                                warn!("[SPIDER DATA] Received unknown category, ignoring symbol map update.");
                            },
                            _ => {
                                for item in parsed_payload.data {
                                    if let (Some(address), Some(symbol)) = (item.contract_address, item.symbol) {
                                        state.token_symbols.insert(address.to_lowercase(), symbol);
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("[DATA ERROR] Failed to parse data-update payload: {}", e);
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