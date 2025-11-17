// packages/backend/src/cache_manager.rs
use super::config::Config;
use std::{path::PathBuf, sync::Arc, time::SystemTime};
use tokio::{fs, time::interval};
use tracing::{info, warn};

struct CacheEntry {
    meta_path: PathBuf,
    data_path: PathBuf,
    modified: SystemTime,
    size: u64,
}

/// 后台缓存清理任务
pub async fn cache_manager_task(config: Arc<Config>) {
    let cleanup_interval = config.cache_cleanup_interval;
    // 使用 MB 计算字节数
    let max_size_bytes = config.max_cache_size_mb * 1024 * 1024;
    // 当缓存超过最大值时，清理到这个比例
    let target_size_bytes = (max_size_bytes as f64 * 0.8) as u64;

    info!(
        "🧹 Cache Manager started. Max size: {} MB, Cleanup interval: {:?}",
        config.max_cache_size_mb, cleanup_interval
    );

    let mut timer = interval(cleanup_interval);
    loop {
        timer.tick().await;
        info!("[CACHE MANAGER] Running cleanup check...");

        match run_cleanup_cycle(&config.cache_dir, max_size_bytes, target_size_bytes).await {
            Ok(cleaned_bytes) => {
                if cleaned_bytes > 0 {
                    info!(
                        "[CACHE MANAGER] Cleanup successful. Freed {:.2} MB.",
                        cleaned_bytes as f64 / 1024.0 / 1024.0
                    );
                } else {
                    info!("[CACHE MANAGER] Cache is within limits. No action needed.");
                }
            }
            Err(e) => {
                warn!("[CACHE MANAGER] Error during cleanup cycle: {}", e);
            }
        }
    }
}

async fn run_cleanup_cycle(
    cache_dir: &str,
    max_size: u64,
    target_size: u64,
) -> Result<u64, std::io::Error> {
    let mut entries = Vec::new();
    let mut total_size = 0;
    let mut read_dir = fs::read_dir(cache_dir).await?;

    while let Some(entry) = read_dir.next_entry().await? {
        let path = entry.path();
        if path.is_file() && path.extension().map_or(false, |s| s == "meta") {
            let meta_path = path;
            let data_path = meta_path.with_extension("data");

            if data_path.exists() {
                let meta = fs::metadata(&meta_path).await?;
                let data_meta = fs::metadata(&data_path).await?;
                let modified = meta.modified()?;
                let size = data_meta.len();
                total_size += size;
                entries.push(CacheEntry {
                    meta_path,
                    data_path,
                    modified,
                    size,
                });
            }
        }
    }

    if total_size <= max_size {
        return Ok(0); // Cache size is within limits
    }

    info!(
        "[CACHE MANAGER] Cache size ({:.2} MB) exceeds max size ({:.2} MB). Starting eviction...",
        total_size as f64 / 1024.0 / 1024.0,
        max_size as f64 / 1024.0 / 1024.0
    );

    // Sort entries by modified time (oldest first) - this is our LRU logic
    entries.sort_by_key(|e| e.modified);

    let mut freed_bytes = 0;
    let mut current_size = total_size;

    for entry in entries {
        if current_size <= target_size {
            break;
        }

        info!("[CACHE EVICT] Deleting old entry: {:?}", entry.meta_path);
        if let Err(e) = fs::remove_file(&entry.meta_path).await {
            warn!("Failed to delete meta file {:?}: {}", entry.meta_path, e);
        }
        if let Err(e) = fs::remove_file(&entry.data_path).await {
            warn!("Failed to delete data file {:?}: {}", entry.data_path, e);
        }

        current_size -= entry.size;
        freed_bytes += entry.size;
    }

    Ok(freed_bytes)
}