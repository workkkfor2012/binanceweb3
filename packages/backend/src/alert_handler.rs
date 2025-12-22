use super::{
    types::{AlertLogEntry, AlertType, HotlistItem},
    ServerState,
};
use socketioxide::SocketIo;
use chrono::Utc;
use uuid::Uuid;
use tracing::info;

// ============== 报警阈值配置 ==============
pub const ALERT_VOLUME_1M_USD: f64 = 50.0;
pub const ALERT_VOLUME_5M_USD: f64 = 200.0;
pub const ALERT_PRICE_CHANGE_1M_PERCENT: f64 = 5.0;
pub const ALERT_PRICE_CHANGE_5M_PERCENT: f64 = 25.0;
pub const ALERT_PRICE_CHANGE_1M_MIN_VOLUME_USD: f64 = 20.0;  // 价格异动需满足的最小成交额
pub const ALERT_PRICE_CHANGE_5M_MIN_VOLUME_USD: f64 = 100.0;
pub const ALERT_COOLDOWN_MS: i64 = 60_000; // 1 分钟冷却
pub const MAX_ALERT_HISTORY: usize = 50;

pub async fn check_and_trigger_alerts(
    items: &[HotlistItem],
    state: &ServerState,
    io: &SocketIo,
) {
    let now = Utc::now().timestamp_millis();
    for item in items {
        let chain = &item.chain;
        let addr = &item.contract_address;
        let symbol = &item.symbol;
        let price = item.price.unwrap_or(0.0);
        
        // 计算成交额 (原始数据是 volume，需乘以价格得到 USD)
        let volume_1m_usd = item.volume1m.unwrap_or(0.0) * price;
        let volume_5m_usd = item.volume5m.unwrap_or(0.0) * price;

        // --- 规则 1: 1 分钟成交额 ---
        if volume_1m_usd > ALERT_VOLUME_1M_USD {
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::Volume1m,
                format!("{} 1分钟 {}美金", symbol, volume_1m_usd.round() as i64),
                now,
            ).await;
        }

        // --- 规则 2: 5 分钟成交额 ---
        if volume_5m_usd > ALERT_VOLUME_5M_USD {
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::Volume5m,
                format!("{} 5分钟 {}美金", symbol, volume_5m_usd.round() as i64),
                now,
            ).await;
        }

        // --- 规则 3: 1 分钟涨跌幅 (需满足最小成交额) ---
        let pc_1m = item.price_change1m.unwrap_or(0.0);
        if pc_1m.abs() > ALERT_PRICE_CHANGE_1M_PERCENT
            && volume_1m_usd > ALERT_PRICE_CHANGE_1M_MIN_VOLUME_USD
        {
            let direction = if pc_1m > 0.0 { "上涨" } else { "下跌" };
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::PriceChange1m,
                format!("{} 1分钟{}{:.1}%", symbol, direction, pc_1m.abs()),
                now,
            ).await;
        }

        // --- 规则 4: 5 分钟涨跌幅 (需满足最小成交额) ---
        let pc_5m = item.price_change5m.unwrap_or(0.0);
        if pc_5m.abs() > ALERT_PRICE_CHANGE_5M_PERCENT
            && volume_5m_usd > ALERT_PRICE_CHANGE_5M_MIN_VOLUME_USD
        {
            let direction = if pc_5m > 0.0 { "上涨" } else { "下跌" };
            try_trigger_alert(
                state, io, chain, addr, symbol,
                AlertType::PriceChange5m,
                format!("{} 5分钟{}{:.1}%", symbol, direction, pc_5m.abs()),
                now,
            ).await;
        }
    }
}

async fn try_trigger_alert(
    state: &ServerState,
    io: &SocketIo,
    chain: &str,
    addr: &str,
    symbol: &str,
    alert_type: AlertType,
    message: String,
    now: i64,
) {
    let type_str = match alert_type {
        AlertType::Volume1m => "volume1m",
        AlertType::Volume5m => "volume5m",
        AlertType::PriceChange1m => "priceChange1m",
        AlertType::PriceChange5m => "priceChange5m",
    };
    
    let cooldown_key = format!("{}:{}:{}", chain, addr.to_lowercase(), type_str);

    // 检查冷却
    let should_alert = {
        if let Some(last_time) = state.alert_cooldowns.get(&cooldown_key) {
            now - *last_time > ALERT_COOLDOWN_MS
        } else {
            true
        }
    };

    if !should_alert {
        return;
    }

    // 更新冷却
    state.alert_cooldowns.insert(cooldown_key, now);

    // 创建日志条目
    let entry = AlertLogEntry {
        id: Uuid::new_v4().to_string(),
        chain: chain.to_string(),
        contract_address: addr.to_string(),
        symbol: symbol.to_string(),
        message: message.clone(),
        timestamp: now,
        alert_type: alert_type.clone(),
    };

    // 更新历史队列
    {
        let mut history = state.alert_history.lock().await;
        history.push_front(entry.clone());
        if history.len() > MAX_ALERT_HISTORY {
            history.pop_back();
        }
    }

    // 广播给所有订阅者
    info!("🚨 [Alert] Broadcasting: {}", message);
    io.emit("alert_update", &entry).await.ok();
}
