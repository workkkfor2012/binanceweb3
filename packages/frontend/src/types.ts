// packages/frontend/src/types.ts

// --- K-Line Related Types ---

export interface LightweightChartKline {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number; 
}

export interface KlineData {
    primaryKey: string;
    address: string;
    chain: string;
    interval: string;
    timestamp: number;
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface KlineUpdatePayload {
    room: string;
    data: LightweightChartKline;
}

export interface KlineFetchErrorPayload {
    key: string; 
    error: string;
}

// --- Meme / Market Data Types ---

// ✨ 新增: MemeItem 接口定义 (对应后端更新)
export interface MemeItem {
    chain: string;
    contractAddress: string;
    symbol: string;
    icon?: string;
  
    name: string;
    progress: number;
    holders: number;
    devMigrateCount?: number;
    createTime: number; 
  
    // ✨ 新增字段
    status?: string;      // 例如 "dex", "bonding_curve"
    updateTime?: number;  // 更新时间戳
  
    twitter?: string;
    telegram?: string;
    website?: string;
    twitterId?: string;   // 辅助字段，如果后端解析了 ID
  
    liquidity?: number;
    marketCap?: number;
  
    narrative?: string;   // 叙事描述
    source?: string;      // 数据来源标记
}

// 扩展 DataPayload 类型以支持本地处理
export type DataAction = 'snapshot' | 'update';

// 这是一个本地的 Payload 定义，用于 Hook 内部转换
export type LocalDataPayload<T> = {
    category: string;
    type: DataAction;
    data: T[];
};