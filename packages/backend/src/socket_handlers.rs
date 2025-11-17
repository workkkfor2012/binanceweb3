// packages/backend/src/socket_handlers.rs
use super::{
    binance_task,
    config::Config,
    state::AppState,
    types::{KlineSubscribePayload, Room},
    ServerState,
};
use socketioxide::{
    extract::{Data, SocketRef},
    SocketIo,
};
use std::{collections::HashSet, sync::Arc};
use tracing::{error, info};

pub async fn on_socket_connect(s: SocketRef, state: ServerState) {
    info!("🔌 [Socket.IO] Client connected: {}", s.id);

    let app_state = state.app_state;
    let config = state.config;
    let io = state.io;

    register_data_update_handler(&s);
    register_kline_subscribe_handler(&s, io, app_state.clone(), config);
    register_kline_unsubscribe_handler(&s, app_state.clone());
    register_disconnect_handler(&s, app_state);
}

fn register_data_update_handler(socket: &SocketRef) {
    socket.on(
        "data-update",
        |s: SocketRef, payload: Data<serde_json::Value>| async move {
            // 核心修正：为 payload.0 添加引用 `&`
            if let Err(e) = s.broadcast().emit("data-broadcast", &payload.0).await {
                error!("[Socket.IO] Failed to broadcast data for {}: {:?}", s.id, e);
            }
        },
    );
}

fn register_kline_subscribe_handler(socket: &SocketRef, io: SocketIo, state: AppState, config: Arc<Config>) {
    socket.on(
        "subscribe_kline",
        move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
            let state = state.clone();
            let config = config.clone();
            let io = io.clone();
            async move {
                let room_name = format!("kl@14@{}@{}", payload.address, payload.interval);
                info!("🔼 [SUB] Client {} subscribing to room: {}", s.id, room_name);
                s.join(room_name.clone());

                state
                    .entry(room_name.clone())
                    .or_insert_with(|| {
                        info!("✨ [ROOM] First subscriber for '{}'. Spawning task...", room_name);
                        let task_handle = tokio::spawn(binance_task::binance_websocket_task(
                            io,
                            room_name.clone(),
                            config,
                        ));
                        Room {
                            clients: HashSet::new(),
                            task_handle,
                        }
                    })
                    .value_mut()
                    .clients
                    .insert(s.id);

                if let Some(room) = state.get(&room_name) {
                    info!(
                        "✓ [SUB] Client {} added to room '{}'. Total clients: {}",
                        s.id,
                        room_name,
                        room.clients.len()
                    );
                }
            }
        },
    );
}

fn register_kline_unsubscribe_handler(socket: &SocketRef, state: AppState) {
    socket.on(
        "unsubscribe_kline",
        move |s: SocketRef, Data(payload): Data<KlineSubscribePayload>| {
            let state = state.clone();
            async move {
                let room_name = format!("kl@14@{}@{}", payload.address, payload.interval);
                info!("🔽 [UNSUB] Client {} from room: {}", s.id, room_name);
                s.leave(room_name.clone());

                if let Some(mut room) = state.get_mut(&room_name) {
                    room.clients.remove(&s.id);
                    if room.clients.is_empty() {
                        drop(room);
                        if let Some((_, room_to_abort)) = state.remove(&room_name) {
                            info!("🗑️ [ROOM] Last client left room '{}'. Aborting task.", room_name);
                            room_to_abort.task_handle.abort();
                        }
                    }
                }
            }
        },
    );
}

fn register_disconnect_handler(socket: &SocketRef, state: AppState) {
    socket.on_disconnect(move |s: SocketRef| {
        let state = state.clone();
        async move {
            info!("[Socket.IO] Client disconnected: {}", s.id);
            let mut empty_rooms = Vec::new();

            for mut room in state.iter_mut() {
                if room.value_mut().clients.remove(&s.id) {
                    info!(
                        "🧹 [CLEANUP] Removed disconnected client {} from room '{}'.",
                        s.id,
                        room.key()
                    );
                    if room.clients.is_empty() {
                        empty_rooms.push(room.key().clone());
                    }
                }
            }

            for room_name in empty_rooms {
                if let Some((_, room)) = state.remove(&room_name) {
                    info!("🗑️ [ROOM] Room '{}' is now empty. Aborting task.", room_name);
                    room.task_handle.abort();
                }
            }
        }
    });
}