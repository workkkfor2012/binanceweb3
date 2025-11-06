// packages/shared-types/src/index.ts

/**
 * 核心的市场数据项结构
 */
export interface MarketItem {
  contractAddress: string;
  symbol: string;
  icon: string;
  price: number;
  priceChange24h: string;
  volume24h: number;
  marketCap: number;
  // 保留索引签名以允许其他未明确定义的字段
  [key: string]: any;
}

/**
 * WebSocket 和数据提取器使用的通用 Payload 结构
 */
export interface DataPayload {
  type: 'snapshot' | 'update';
  data: MarketItem[];
}

/**
 * 注入浏览器的脚本回传给 Playwright 的数据结构
 */
export interface ExtractedDataPayload {
  type: 'snapshot' | 'update' | 'no-change';
  data?: MarketItem[];
  path: string | null;
  duration: string;
  readDuration: string;
  diffDuration: string;
  totalCount: number;
  changedCount: number;
  cacheHit: boolean;
}