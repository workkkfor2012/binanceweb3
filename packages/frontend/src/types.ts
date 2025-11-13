// packages/frontend/src/types.ts
export interface Kline {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number; // K线开始的毫秒级时间戳
    time: number; // lightweight-charts uses seconds
}

export interface LightweightChartKline {
    time: number; // UNIX timestamp in seconds
    open: number;
    high: number;
    low: number;
    close: number;
}

// 这是存储在IndexedDB中的完整结构
export interface KlineData extends Kline {
    primaryKey: string; // e.g., "0x..._bsc_1m"
    address: string;
    chain: string;
    interval: string;
}