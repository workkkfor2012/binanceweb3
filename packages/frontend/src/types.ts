// packages/frontend/src/types.ts
// ✨ 整个文件简化，只保留与图表直接相关的类型

// 后端返回的、用于 lightweight-charts 的K线数据结构
// 注意：time 是秒级时间戳
export interface LightweightChartKline {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number; // 可选，图表不直接使用，但可能用于其他地方
}

// 实时K线更新的 payload (Binance WebSocket 推送的)
export interface KlineUpdatePayload {
    room: string;
    data: LightweightChartKline;
}

// K线历史数据请求失败的 payload
export interface KlineFetchErrorPayload {
    key: string; // e.g., "0x..._bsc_1m"
    error: string;
}