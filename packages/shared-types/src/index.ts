// packages/shared-types/src/index.ts
/**
 * 核心的市场数据项结构
 */
export interface MarketItem {
  chain: string; 
  contractAddress: string;
  symbol: string;
  icon: string;
  price: number;
  priceChange24h: string;
  volume24h: number;
  marketCap: number;
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

/**
 * 定义了从目标网站提取并推送到前端的具体数据字段
 * 这是整个系统监控字段的“单一事实来源”
 */
export const DESIRED_FIELDS = [
    'chain', 'chainId', 'contractAddress', 'symbol', 'icon',
    'marketCap', 'price',
    'volume1m', 'volume5m', 'volume1h', 'volume4h', 'volume24h',
    'priceChange1m', 'priceChange5m', 'priceChange1h', 'priceChange4h', 'priceChange24h'
];