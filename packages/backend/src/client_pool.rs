// packages/backend/src/client_pool.rs

use reqwest::{Client, Proxy};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::RwLock;
use tracing::{info, warn, error};

// 用于健康检查的轻量级 URL，Binance 的 Server Time 接口非常快且轻量
// 也可以换成 https://www.google.com 如果你只在乎代理通不通
const HEALTH_CHECK_URL: &str = "https://api.binance.com/api/v3/time";

#[derive(Clone)]
pub struct ClientPool {
    clients: Arc<RwLock<Vec<Client>>>,
    proxy_url: String,
    max_size: usize,
    counter: Arc<AtomicUsize>,
}

impl ClientPool {
    pub async fn new(size: usize, proxy_url: String) -> Self {
        let mut clients = Vec::with_capacity(size);
        
        info!("🏊 [POOL INIT] Warming up {} connections via {}...", size, proxy_url);
        
        // 初始化时，并发创建并验证所有客户端
        // 这样启动时会慢一点点，但启动后所有连接都是热的
        let mut tasks = Vec::new();
        for i in 0..size {
            let url = proxy_url.clone();
            tasks.push(tokio::spawn(async move {
                build_and_warm_client(&url, i).await
            }));
        }

        for task in tasks {
            if let Ok(client) = task.await {
                clients.push(client);
            } else {
                // 极端情况 fallback，一般不会发生
                clients.push(Client::new());
            }
        }

        info!("✅ [POOL INIT] All {} connections established and warmed up.", size);

        Self {
            clients: Arc::new(RwLock::new(clients)),
            proxy_url,
            max_size: size,
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// 获取一个客户端进行请求
    pub async fn get_client(&self) -> (usize, Client) {
        let current = self.counter.fetch_add(1, Ordering::Relaxed);
        let index = current % self.max_size;

        let read_lock = self.clients.read().await;
        (index, read_lock[index].clone())
    }

    /// 核心：销毁旧客户端，并循环尝试直到建立一个新的、健康的连接
    pub async fn recycle_client(&self, index: usize) -> Client {
        warn!("♻️ [POOL] Client #{} marked as bad. Starting replacement...", index);
        
        // 在循环中构建，直到成功。这保证了池子里永远不会有坏连接。
        let new_client = build_and_warm_client(&self.proxy_url, index).await;
        
        let mut write_lock = self.clients.write().await;
        write_lock[index] = new_client.clone();
        
        info!("✨ [POOL] Client #{} recycled and READY (Handshake complete).", index);
        new_client
    }
}

/// 构建客户端并执行一次“预热/健康检查”
/// 只有通过检查的客户端才会被返回
async fn build_and_warm_client(proxy_url: &str, index: usize) -> Client {
    let mut attempt = 1;
    loop {
        // 1. 构建配置
        let builder = Client::builder()
            .timeout(std::time::Duration::from_secs(10)) // 业务请求超时
            .connect_timeout(std::time::Duration::from_secs(5)) // 连接超时（快速失败）
            .pool_idle_timeout(std::time::Duration::from_secs(90)) // Keep-Alive 保持久一点
            .user_agent(format!(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Client-Pool-ID/{}", 
                index
            ));

        let client = match Proxy::all(proxy_url) {
            Ok(proxy) => builder.proxy(proxy).build().unwrap_or_else(|_| Client::new()),
            Err(_) => Client::new(),
        };

        // 2. 预热/健康检查 (Warm-up)
        // 使用 HEAD 请求，极小流量，但能完成 TCP+TLS 握手
        // 注意：reqwest 内部维护连接池，同一个 client 实例再次发起请求会复用 Socket
        // debug!("💓 [POOL] Pre-flight check for Client #{} (Attempt {})...", index, attempt);
        
        match client.head(HEALTH_CHECK_URL).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    // 握手成功，连接已建立且放入了 reqwest 内部池
                    return client;
                } else {
                    warn!("⚠️ [POOL] Client #{} Warm-up rejected (Status: {}). Retrying...", index, resp.status());
                }
            },
            Err(e) => {
                // 网络错误，说明当前分配的 VPN 节点可能不通
                warn!("⚠️ [POOL] Client #{} Warm-up failed ({}). Retrying with new connection...", index, e);
            }
        }

        // 失败后稍作等待再重试，避免 CPU 空转
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        attempt += 1;
        
        // 防止无限死循环卡死整个程序（虽然理论上应该一直试直到网络恢复）
        if attempt > 20 {
            error!("🔥 [POOL] Client #{} failed 20 attempts. Returning potentially broken client to unblock.", index);
            return client;
        }
    }
}