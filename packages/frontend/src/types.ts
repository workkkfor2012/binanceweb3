// packages/frontend/src/types.ts

// 后端返回的、用于 lightweight-charts 的K线数据结构
// 注意：time 是秒级时间戳
export interface LightweightChartKline {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number; 
}

// 数据库和完整K线逻辑使用的完整数据结构
export interface KlineData {
    primaryKey: string; // 复合主键
    address: string;
    chain: string;
    interval: string;
    timestamp: number; // 毫秒级时间戳
    time: number;      // 秒级时间戳 (用于图表)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

// 实时K线更新的 payload
export interface KlineUpdatePayload {
    room: string;
    data: LightweightChartKline;
}

// K线历史数据请求失败的 payload
export interface KlineFetchErrorPayload {
    key: string; 
    error: string;
}