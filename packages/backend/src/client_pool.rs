// packages/backend/src/client_pool.rs


use reqwest::{Client, Proxy};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::RwLock;
use tracing::{error, info, warn};

// 修改为我们的目标域名，或者一个通用的高可用域名
const HEALTH_CHECK_URL: &str = "https://dquery.sintral.io";

#[derive(Clone)]
pub struct ClientPool {
    clients: Arc<RwLock<Vec<Client>>>,
    proxy_url: Option<String>, // ✨ 改为 Option，None 表示直连
    max_size: usize,
    counter: Arc<AtomicUsize>,
}

impl ClientPool {
    // ✨ proxy_url 改为 Option<String>
    pub async fn new(size: usize, proxy_url: Option<String>) -> Self {
        let mut clients = Vec::with_capacity(size);

        if let Some(ref p_url) = proxy_url {
            // --- 代理模式 (原有逻辑) ---
            info!(
                "🏊 [POOL INIT] Proxy Mode: Warming up {} connections via {}...",
                size, p_url
            );
            let mut tasks = Vec::new();
            for i in 0..size {
                let url = p_url.clone();
                tasks.push(tokio::spawn(async move {
                    build_and_warm_client(Some(&url), i).await
                }));
            }

            for task in tasks {
                if let Ok(client) = task.await {
                    clients.push(client);
                } else {
                    clients.push(Client::new());
                }
            }
        } else {
            // --- ✨ 直连模式 (新逻辑) ---
            // 只需要暖场一次
            info!("🚀 [POOL INIT] Direct Mode: Warming up network stack (single check)...");
            
            // 创建一个高性能直连客户端
            let master_client = build_and_warm_client(None, 0).await;
            
            // 在直连模式下，reqwest::Client 内部有连接池，是线程安全的。
            // 为了保持 Pool 接口一致性，我们填入同一个 client 的克隆（开销极小）
            for _ in 0..size {
                clients.push(master_client.clone());
            }
        }

        info!(
            "✅ [POOL INIT] Ready. Size: {}, Mode: {}",
            size,
            if proxy_url.is_some() { "Proxy" } else { "Direct" }
        );

        Self {
            clients: Arc::new(RwLock::new(clients)),
            proxy_url,
            max_size: size,
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn get_client(&self) -> (usize, Client) {
        let current = self.counter.fetch_add(1, Ordering::Relaxed);
        let index = current % self.max_size;

        let read_lock = self.clients.read().await;
        (index, read_lock[index].clone())
    }

    pub async fn recycle_client(&self, index: usize) -> Client {
        // 如果是直连模式，通常不需要 recycle，除非网络彻底断了。
        // 但为了健壮性，我们还是重新构建一次
        if self.proxy_url.is_none() {
            warn!("♻️ [POOL] Refreshing Direct Client #{}...", index);
        } else {
            warn!("♻️ [POOL] Proxy Client #{} marked as bad. Swapping...", index);
        }

        let new_client = build_and_warm_client(self.proxy_url.as_deref(), index).await;

        let mut write_lock = self.clients.write().await;
        write_lock[index] = new_client.clone();

        // 如果是直连模式，一个 client 刷新了，其实可以考虑刷新所有，
        // 但为了简单，只刷新当前 slot 也没问题。
        
        new_client
    }

}

async fn build_and_warm_client(proxy_url: Option<&str>, index: usize) -> Client {
    let mut attempt = 1;
    loop {
        let mut builder = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .connect_timeout(std::time::Duration::from_secs(5))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .user_agent(format!(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Client-Pool-ID/{}",
                index
            ));

        if let Some(url) = proxy_url {
            if let Ok(proxy) = Proxy::all(url) {
                builder = builder.proxy(proxy);
            }
        }

        let client = builder.build().unwrap_or_else(|_| Client::new());

        // 暖场检查
        // 如果是直连，且是第0个以后的（仅用于填充Pool），其实可以跳过检查
        // 但为了保险，还是保留简单的 HEAD 请求
        // 针对 dquery.sintral.io，如果不支持 HEAD，可以用 GET
        // 既然用户确认该域名可访问，我们尽量轻量化
        match client.head(HEALTH_CHECK_URL).send().await {
            Ok(_) => {
                // 只要有回应（哪怕是 404/405），说明网络通了
                return client;
            }
            Err(e) => {
                // 如果是直连模式，失败可能意味着本机没网
                warn!(
                    "⚠️ [POOL] Client #{} Warm-up failed ({}). Retrying...",
                    index, e
                );
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        attempt += 1;

        if attempt > 5 { // 直连模式下，不需要试那么多次
            error!(
                "🔥 [POOL] Client #{} failed warm-up. Returning anyway.",
                index
            );
            return client;
        }
    }

}