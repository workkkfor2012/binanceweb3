// packages/frontend/src/types.ts

// ✅ 核心修改：从 shared-types 导入核心业务实体，遵循 Single Source of Truth
import type {
    MemeItem as SharedMemeItem,
    HotlistItem as SharedHotlistItem,
    MarketItem as SharedMarketItem,
    AlertLogEntry as SharedAlertLogEntry,
    AlertType as SharedAlertType
} from 'shared-types';

// ============================================================================
// 1. 核心业务数据 (直接映射 shared-types)
// ============================================================================
export type MemeItem = SharedMemeItem;
export type HotlistItem = SharedHotlistItem;
export type MarketItem = SharedMarketItem;
export type AlertLogEntry = SharedAlertLogEntry;
export type AlertType = SharedAlertType;

// ============================================================================
// 2. 前端/UI 专用类型 (后端不关心的部分保留在这里)
// ============================================================================

// --- K-Line 图表库 (Lightweight Charts) 专用格式 ---
export interface LightweightChartKline {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export type KlineTick = LightweightChartKline;

// --- 本地 IndexedDB 存储结构 ---
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

// --- Socket 消息负载的本地包装 ---
export interface KlineUpdatePayload {
    room: string;
    data: LightweightChartKline;
}

export interface KlineFetchErrorPayload {
    key: string;
    error: string;
}

// --- 本地 Hook 使用的数据动作 ---
export type DataAction = 'snapshot' | 'update';

// 这是一个本地的 Payload 定义，用于 Hook 内部转换
// 这里的 T 现在会正确解析为来自 shared-types 的结构
export type LocalDataPayload<T> = {
    category: string;
    type: DataAction;
    data: T[];
};