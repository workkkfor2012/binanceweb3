// packages/backend/src/client_pool.rs

use reqwest::{Client, Proxy};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::RwLock;
use tracing::{error, info, warn};

// 健康检查地址，用于验证代理连接是否真正可用
const HEALTH_CHECK_URL: &str = "https://web3.binance.com";

#[derive(Clone)]
pub struct ClientPool {
    clients: Arc<RwLock<Vec<Client>>>,
    proxy_url: Option<String>,
    max_size: usize,
    counter: Arc<AtomicUsize>,
    name: String, // 用于日志区分是 DIRECT 还是 PROXY 池
}

impl ClientPool {
    /// 初始化连接池，并并发预热所有连接
    pub async fn new(size: usize, proxy_url: Option<String>, name: String) -> Self {
        let mut clients = Vec::with_capacity(size);

        info!(
            "🏊 [POOL:{}] Initializing with {} clients. Mode: {}",
            name,
            size,
            if proxy_url.is_some() { "PROXY" } else { "DIRECT" }
        );

        // 并发构建，加快启动速度
        let mut tasks = Vec::new();
        for i in 0..size {
            let p_url = proxy_url.clone();
            let pool_name = name.clone();
            tasks.push(tokio::spawn(async move {
                build_and_warm_client(p_url.as_deref(), i, &pool_name).await
            }));
        }

        for task in tasks {
            match task.await {
                Ok(client) => clients.push(client),
                Err(_) => {
                    // ⚠️ 安全修正：即使 Spawn 失败，也必须填充占位符。
                    // 必须使用 safe fallback，防止代理模式下变成直连。
                    clients.push(build_safe_fallback(proxy_url.as_deref()));
                }
            }
        }

        Self {
            clients: Arc::new(RwLock::new(clients)),
            proxy_url,
            max_size: size,
            counter: Arc::new(AtomicUsize::new(0)),
            name,
        }
    }

    /// 获取一个客户端句柄和它的索引（索引用于后续回收）
    pub async fn get_client(&self) -> (usize, Client) {
        // 简单的轮询负载均衡
        let current = self.counter.fetch_add(1, Ordering::Relaxed);
        let index = current % self.max_size;
        
        let read_lock = self.clients.read().await;
        (index, read_lock[index].clone())
    }

    /// ✨ 核心逻辑：销毁指定索引的旧连接，建立新连接
    /// 调用此方法意味着调用者认为该连接已损坏（超时/被封/断开）
    pub async fn recycle_client(&self, index: usize) -> Client {
        warn!("♻️ [POOL:{}] Recycling Client #{} (Cleaning up dirty connection)...", self.name, index);

        // 1. 在锁外构建并暖机新连接 (这包含网络 IO，耗时较长，不要阻塞锁)
        // 这会触发新的 TCP 握手，从而让底层代理软件分配新的出口 IP/节点
        let new_client = build_and_warm_client(self.proxy_url.as_deref(), index, &self.name).await;

        // 2. 获取写锁，替换旧连接
        let mut write_lock = self.clients.write().await;
        write_lock[index] = new_client.clone();
        
        info!("✅ [POOL:{}] Client #{} refreshed and ready.", self.name, index);
        new_client
    }
}

/// 🛡️ 安全回退构建器
/// 如果指定了 proxy_url，但构建失败，必须返回一个配置了“死胡同”代理的 Client。
/// 这样请求会超时，但绝对不会泄露本机 IP。
fn build_safe_fallback(proxy_url: Option<&str>) -> Client {
    if let Some(_) = proxy_url {
        // 配置一个无法连接的代理地址 (黑洞)
        let broken_proxy = Proxy::all("http://0.0.0.0:1").unwrap();
        Client::builder()
            .proxy(broken_proxy)
            .build()
            .unwrap_or_else(|_| Client::new()) // 如果连这也失败，Client::new 也没办法，但通常不会
    } else {
        // 直连模式下，Fallback 就是普通 Client
        Client::new()
    }
}

/// 构建客户端并尝试发起一个请求来验证连通性
async fn build_and_warm_client(proxy_url: Option<&str>, index: usize, pool_name: &str) -> Client {
    // 最多重试 3 次构建，确保拿到的连接是通的
    for attempt in 1..=3 {
        let mut builder = Client::builder()
            .timeout(std::time::Duration::from_secs(8)) // 构建超时
            .connect_timeout(std::time::Duration::from_secs(5)) // 连接超时
            // 保持长连接，直到手动回收
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");

        if let Some(url) = proxy_url {
            match Proxy::all(url) {
                Ok(proxy) => {
                    builder = builder.proxy(proxy);
                }
                Err(e) => {
                    error!("❌ [POOL:{}] Invalid Proxy URL: {}. SECURITY RISK.", pool_name, e);
                    // 代理配置错误，直接返回死胡同 Client，防止直连
                    return build_safe_fallback(proxy_url);
                }
            }
        }

        let client = match builder.build() {
            Ok(c) => c,
            Err(e) => {
                error!("❌ [POOL:{}] Build failed (Attempt {}): {}", pool_name, attempt, e);
                // 只有最后一次失败才返回 fallback，中间失败则 continue 重试
                if attempt == 3 {
                    return build_safe_fallback(proxy_url);
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                continue;
            }
        };

        // --- 暖机检查 (Warm-up) ---
        // 移除严格的暖机检查。因为并发启动 30 个客户端去请求 web3.binance.com 可能会触发 WAF/RateLimit，
        // 导致大量客户端被错误判定为“不可用”并替换为 broken_client (0.0.0.0)。
        // 实际的请求错误由 http_handlers 中的重试逻辑处理即可。
        if proxy_url.is_some() {
             info!("✅ [POOL:{}] Client #{} created (No Http Warm-up).", pool_name, index);
        }
        
        return client;
    }
    
    error!("🔥 [POOL:{}] Client #{} failed all build attempts.", pool_name, index);
    build_safe_fallback(proxy_url) 
}