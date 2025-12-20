// packages/shared-types/src/index.ts

// 1. 导出自动生成的绑定类型 (由 Rust 后端通过 ts-rs 生成)
export * from './bindings/HotlistItem';
export * from './bindings/MemeScanItem';
export * from './bindings/DataAction';
export * from './bindings/DataPayload';
export * from './bindings/KlineTick';

// 2. 导出手动定义的类型 (爬虫原始 Raw Dump 等)
export * from './meme-rush';

// ----------------------------------------------------------------------------
// 3. 核心常量定义 (用于爬虫 Dynamic Extraction)
// ----------------------------------------------------------------------------
export const DESIRED_FIELDS = [
    'contractAddress',
    'symbol',
    'icon',
    'price',
    'marketCap',
    'volume24h',
    'priceChange24h',
    'volume1h',
    'priceChange1h',
    'volume5m',
    'priceChange5m',
    'volume1m',
    'priceChange1m',
    'volume4h',
    'priceChange4h'
];

// ----------------------------------------------------------------------------
// 4. 运行时类型 / 别名 (用于平滑过渡或前端特定逻辑)
// ----------------------------------------------------------------------------
import { HotlistItem } from './bindings/HotlistItem';
import { MemeScanItem } from './bindings/MemeScanItem';

// ExtractedDataPayload 是爬虫内部在浏览器环境使用的结构，由于不经过 Rust 后端，保留 TS 定义
export interface ExtractedDataPayload {
    type: 'snapshot' | 'update' | 'no-change';
    data?: any[];
    path: string | null;
    duration: string;
    readDuration: string;
    diffDuration: string;
    totalCount: number;
    changedCount: number;
    cacheHit: boolean;
}

/**
 * MemeItem 在前端被广泛使用，且包含一些前端计算/装饰字段。
 * 我们将其定义为基础 MemeScanItem 的扩展。
 */
export interface MemeItem extends MemeScanItem {
    // 这里可以添加以后前端专用的扩展字段，目前先继承所有后端字段
    // 如果后续后端增加了字段，MemeItem 会自动同步
    source: 'meme-rush';
}

export type MarketItem = HotlistItem | MemeItem;