// packages/backend/src/bin/core.rs
use backend::{init_tracing, setup_shared_state, socket_handlers, http_handlers, cache_manager, kline_handler};
use axum::{routing::get, Router};
use socketioxide::SocketIo;
use std::sync::Arc;
use tracing::{info, warn};
use std::fs::File;
use std::io::BufReader;
use rustls::ServerConfig;
use tower_http::cors::{Any, CorsLayer};

#[tokio::main]
async fn main() {
    init_tracing();
    info!("🚀 Starting Backend Core (Cloud Mode)");

    let (layer, io) = SocketIo::builder().max_buffer_size(40960).build_layer();
    let config = Arc::new(backend::config::Config::new());
    let server_state = setup_shared_state(config.clone(), io.clone()).await;

    let socket_state = server_state.clone();
    io.ns("/", move |s: socketioxide::extract::SocketRef| {
        let state = socket_state.clone();
        async move {
            // Core 模式仅注册数据更新和报警相关处理器
            // 虽然这里目前是全注册，但逻辑上我们只关心 data-update
            socket_handlers::on_socket_connect(s, state).await;
        }
    });

    // 定时任务：流动性裁剪 & 缓存管理
    let db_pool_for_prune = server_state.db_pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            match kline_handler::prune_liquidity_history(&db_pool_for_prune).await {
                Ok(deleted) => if deleted > 0 { info!("Sweep: Deleted {} liq history", deleted); },
                Err(e) => warn!("Sweep Error: {}", e),
            }
        }
    });
    tokio::spawn(cache_manager::cache_manager_task(config));

    let app = Router::new()
        .route("/desired-fields", get(http_handlers::desired_fields_handler))
        .route("/image-proxy", get(http_handlers::image_proxy_handler))
        .with_state(server_state)
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(layer);

    // HTTPS/HTTP Server logic (from original main.rs)
    let cert_file = File::open("cert.pem")
        .expect("Failed to open cert.pem");
    let key_file = File::open("key.pem")
        .expect("Failed to open key.pem");
    let mut cert_reader = BufReader::new(cert_file);
    let mut key_reader = BufReader::new(key_file);
    let certs = rustls_pemfile::certs(&mut cert_reader).collect::<Result<Vec<_>, _>>().expect("Parse cert");
    let key = rustls_pemfile::private_key(&mut key_reader).expect("Read key").expect("No key");
    let mut tls_config = ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key).expect("TLS config");
    tls_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    let rustls_config = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls_config));

    info!("🔒 HTTPS port 30001 | 🌐 HTTP port 30002");
    
    let https_app = app.clone();
    let http_app = app;
    
    let https_server = tokio::spawn(async move {
        axum_server::bind_rustls("0.0.0.0:30001".parse::<std::net::SocketAddr>().unwrap(), rustls_config)
            .serve(https_app.into_make_service()).await.unwrap();
    });
    
    let http_server = tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind("0.0.0.0:30002").await.unwrap();
        axum::serve(listener, http_app).await.unwrap();
    });
    
    tokio::select! {
        _ = https_server => info!("Core HTTPS stopped"),
        _ = http_server => info!("Core HTTP stopped"),
    }
}
