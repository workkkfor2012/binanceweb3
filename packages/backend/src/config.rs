// packages/backend/src/config.rs
use std::time::Duration;

#[derive(Clone)]
pub struct Config {
    pub cache_dir: String,
    pub binance_wss_url: String,
    pub proxy_addr: String,
    pub heartbeat_interval: Duration,
    pub desired_fields: Vec<&'static str>,
    // 重命名并修改单位为 MB
    pub max_cache_size_mb: u64,
    pub cache_cleanup_interval: Duration,
}

impl Config {
    pub fn new() -> Self {
        Self {
            cache_dir: "./image_cache".to_string(),
            binance_wss_url: "wss://nbstream.binance.com/w3w/stream".to_string(),
            proxy_addr: "127.0.0.1:1080".to_string(),
            heartbeat_interval: Duration::from_secs(20),
            desired_fields: vec![
                "icon",
                "symbol",
                "price",
                "marketCap",
                "chain",
                "chainId",
                "contractAddress",
                "volume1m",
                "volume5m",
                "volume1h",
                "volume4h",
                "volume24h",
                "priceChange1m",
                "priceChange5m",
                "priceChange1h",
                "priceChange4h",
                "priceChange24h",
            ],
            // 默认最大缓存为 1024 MB (1 GB)
            max_cache_size_mb: 70,
            // 默认每小时清理一次
            cache_cleanup_interval: Duration::from_secs(3600),
        }
    }
}