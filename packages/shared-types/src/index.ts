// packages/shared-types/src/index.ts

// 导出 MemeRush 原始类型，方便外部直接从 index 引用 (可选，但推荐)
export * from './meme-rush';

// ----------------------------------------------------------------------------
// 1. 核心常量定义
// ----------------------------------------------------------------------------

/**
 * Hotlist (热门榜) 爬虫默认需要的字段列表。
 * 这些字段对应页面 DOM 上的属性名，用于浏览器脚本提取原始数据。
 */
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
  'priceChange5m'
];

// ----------------------------------------------------------------------------
// 2. 通信载荷定义 (Browser Script -> Extractor Node Process)
// ----------------------------------------------------------------------------

/**
 * 浏览器脚本 (browser-script.js) 回传给 Node.js 进程的原始数据包结构。
 * 注意：这里的 data 是未经处理的原始对象 (Raw Object)，通常属性值还是字符串。
 */
export interface ExtractedDataPayload {
  type: 'snapshot' | 'update' | 'no-change';
  // 这里使用 any[]，因为从浏览器传来的原始数据尚未映射为严格的 HotlistItem 或 MemeItem
  data?: any[]; 
  path: string | null;
  duration: string;
  readDuration: string;
  diffDuration: string;
  totalCount: number;
  changedCount: number;
  cacheHit: boolean;
}

// ----------------------------------------------------------------------------
// 3. 基础业务实体接口
// ----------------------------------------------------------------------------

// 基础字段 (仅提取两者绝对共有的核心物理属性)
interface BaseItem {
  chain: string;
  contractAddress: string;
  symbol: string;
  icon?: string;
  updateTime: number; // 统一的数据更新时间戳
}

// Hotlist 专用接口 (常规热门币)
export interface HotlistItem extends BaseItem {
  price: number;
  marketCap: number;
  // 常规交易数据
  volume1h: number;
  volume24h: number;
  priceChange1h: number;
  priceChange24h: number;
  // K线相关
  volume5m?: number;
  priceChange5m?: number;
  
  source: 'hotlist'; // 显式标记源
}

// Meme Rush 专用接口 (新币/土狗)
export interface MemeItem extends BaseItem {
  name: string;          // Meme 往往需要全名
  // Meme 核心指标
  progress: number;      // 绑定曲线进度 (0-100)
  holders: number;
  devMigrateCount: number; // 关键指标
  createTime: number;
  
  // 社交信息 (Meme 必须)
  twitter?: string;
  telegram?: string;
  website?: string;
  
  // 交易属性 (可能与 Hotlist 计算方式不同，例如取自 liquidity)
  liquidity: number;
  marketCap: number;     // 这里的市值通常是估算的
  status: 'trading' | 'migrating' | 'dex'; // 状态流转
  
  source: 'meme-rush'; // 显式标记源
}

// ----------------------------------------------------------------------------
// 4. WebSocket 推送载荷 (Extractor -> Backend -> Frontend)
// ----------------------------------------------------------------------------

export type DataPayload = 
  | { category: 'hotlist'; type: 'snapshot' | 'update'; data: HotlistItem[] }
  | { category: 'meme_new'; type: 'snapshot' | 'update'; data: MemeItem[] };

export type MarketItem = HotlistItem | MemeItem;