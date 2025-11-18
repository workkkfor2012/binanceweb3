// packages/backend/src/socket_handlers.rs
use super::{
    binance_task,
    // config::Config,      // <-- 移除
    // state::AppState,     // <-- 移除
    types::{DataPayload, KlineSubscribePayload, Room},
    ServerState,
};
// use dashmap::DashMap;   // <-- 移除
use socketioxide::{
    extract::{Data, SocketRef},
    // SocketIo,           // <-- 移除
};
use std::collections::HashSet;
// use std::sync::Arc;    // <-- 移除
use tracing::{error, info, warn};

pub async fn on_socket_connect(s: SocketRef, state: ServerState) {
    info!("🔌 [Socket.IO] Client connected: {}", s.id);

    register_data_update_handler(&s, state.clone());
    register_kline_subscribe_handler(&s, state.clone());
    register_kline_unsubscribe_handler(&s, state.clone());
    register_disconnect_handler(&s, state);
}

fn register_data_update_handler(socket: &SocketRef, state: ServerState) {
    socket.on(
        "data-update",
        move |s: SocketRef, payload: Data<serde_json::Value>| {
            let state = state.clone();
            async move {
                if let Err(e) = s.broadcast().emit("data-broadcast", &payload.0).await {
                    error!("[Socket.IO] Failed to broadcast data for {}: {:?}", s.id, e);
                }

                match serde_json::from_value::<DataPayload>(payload.0) {
                    Ok(parsed_payload) => {
                        for item in parsed_payload.data {
                            // 使用 if let 来安全地解包 Option
                            if let (Some(address), Some(symbol)) = (item.contract_address, item.symbol) {
                                state.token_symbols.insert(address.to_lowercase(), symbol);
                            }
                        }
                    }
                    Err(e) => {
                        warn!("[SYMBOL MAP] Failed to parse data-update payload for symbol mapping: {}", e);
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
                info!("✅ [HANDLER TRIGGERED] 'subscribe_kline' with payload: {:?}", payload);

                let address_lowercase = payload.address.to_lowercase();
                let symbol = state.token_symbols
                    .get(&address_lowercase)
                    .map_or_else(
                        || format!("{}...", &payload.address[0..6]),
                        |s| s.value().clone()
                    );

                let pool_id = match payload.chain.as_str() {
                    "bsc" => 14, "sol" | "solana" => 16, "base" => 199,
                    unsupported_chain => {
                        warn!("Unsupported chain '{}' for {}. Ignored.", unsupported_chain, s.id);
                        return;
                    }
                };

                let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
                let log_display_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);

                info!("🔼 [JOIN] Client {} joining room: {}", s.id, log_display_name);
                s.join(room_name.clone());

                state.app_state
                    .entry(room_name.clone())
                    .or_insert_with(|| {
                        info!("✨ [ROOM] First subscriber for '{}'. Spawning task...", log_display_name);
                        let task_handle = tokio::spawn(binance_task::binance_websocket_task(
                            state.io.clone(),
                            room_name.clone(),
                            symbol.clone(), 
                            state.config.clone(),
                        ));
                        Room {
                            clients: HashSet::new(),
                            task_handle,
                            symbol,
                        }
                    })
                    .value_mut()
                    .clients
                    .insert(s.id);

                if let Some(room) = state.app_state.get(&room_name) {
                    info!("✓ [JOIN] Client {} added. Total clients in '{}': {}", s.id, log_display_name, room.clients.len());
                }
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
                 let symbol = state.token_symbols
                    .get(&payload.address.to_lowercase())
                    .map_or_else(|| format!("{}...", &payload.address[0..6]), |s| s.value().clone());

                let pool_id = match payload.chain.as_str() {
                    "bsc" => 14, "sol" | "solana" => 16, "base" => 199,
                    _ => { return; }
                };
                let room_name = format!("kl@{}@{}@{}", pool_id, payload.address, payload.interval);
                let log_display_name = format!("kl@{}@{}@{}", pool_id, &symbol, payload.interval);

                info!("🔽 [UNSUB] Client {} from room: {}", s.id, log_display_name);
                s.leave(room_name.clone());

                if let Some(mut room) = state.app_state.get_mut(&room_name) {
                    room.clients.remove(&s.id);
                    if room.clients.is_empty() {
                        drop(room);
                        if let Some((_, room_to_abort)) = state.app_state.remove(&room_name) {
                            info!("🗑️ [ROOM] Last client left '{}'. Aborting task.", log_display_name);
                            room_to_abort.task_handle.abort();
                        }
                    } else {
                        info!("[UNSUB] Room '{}' still has {} clients.", log_display_name, room.clients.len());
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
            info!("🔌 [Socket.IO] Client disconnected: {}", s.id);
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
                    info!("🧹 [CLEANUP] Removed client {} from room '{}'.", s.id, &log_display_name);
                    if entry.clients.is_empty() {
                        empty_rooms.push((entry.key().clone(), log_display_name));
                    }
                }
            }

            for (room_name, log_display_name) in empty_rooms {
                if let Some((_, room)) = state.app_state.remove(&room_name) {
                    info!("🗑️ [ROOM] Room '{}' is now empty. Aborting task.", log_display_name);
                    room.task_handle.abort();
                }
            }
        }
    });
}