// packages/shared-types/src/index.ts

// 导出 MemeRush 原始类型，方便外部直接从 index 引用
export * from './meme-rush';

// ----------------------------------------------------------------------------
// 1. 核心常量定义 (用于爬虫 Dynamic Extraction)
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
  // ✨ [Critical Fix] 显式添加 1m 和 4h 字段，确保爬虫知道要抓取它们
  'volume1m',
  'priceChange1m',
  'volume4h',
  'priceChange4h'
];

// ----------------------------------------------------------------------------
// 2. 通信载荷定义
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 3. 基础业务实体接口
// ----------------------------------------------------------------------------
interface BaseItem {
  chain: string;
  contractAddress: string;
  symbol: string;
  icon?: string;
  updateTime: number;
}

// 🔥 Hotlist 专用接口 (已补全 App.tsx 所需的所有字段)
export interface HotlistItem extends BaseItem {
  price: number;
  marketCap: number;
  
  // App.tsx 中使用了 chainId 用于展示
  chainId?: string; 

  // --- 1m (App.tsx 依赖此字段) ---
  volume1m?: number;
  priceChange1m?: number;

  // --- 5m ---
  volume5m?: number;
  priceChange5m?: number;

  // --- 1h ---
  volume1h: number;
  priceChange1h: number;

  // --- 4h (App.tsx 依赖此字段) ---
  volume4h?: number;
  priceChange4h?: number;

  // --- 24h ---
  volume24h: number;
  priceChange24h: number;

  source: 'hotlist';
}

// 🐶 Meme Rush 专用接口 (已大幅扩展以包含所有 Raw Data 字段)
export interface MemeItem extends BaseItem {
  name: string;

  // --- 核心状态 ---
  progress: number;
  status: 'trading' | 'migrating' | 'dex' | 'bonding_curve';
  createTime: number;    // 原始创建时间
  migrateTime: number;   // 迁移时间 (如果是 '0' 则未迁移)
  displayTime: number;   // 前端排序用的统一时间

  // --- 交易数据 ---
  liquidity: number;
  marketCap: number;
  volume: number;        // 总交易量
  count: number;         // 总交易笔数
  countBuy: number;      // 🟢 买单数
  countSell: number;     // 🔴 卖单数
  buySellRatio: number;  // ⚖️ 买卖比

  // --- 持仓分析 (关键风控数据) ---
  holders: number;
  holdersTop10Percent: number;    // 前10持仓占比
  holdersDevPercent: number;      // Dev持仓占比
  holdersSniperPercent: number;   // 🔫 狙击手占比
  holdersInsiderPercent: number;  // 🐀 老鼠仓占比
  devSellPercent: number;         // Dev卖出比例

  // --- 开发者历史 ---
  devMigrateCount: number; // 🏆 开发者发币历史

  // --- 社交与推广 ---
  twitter?: string;
  twitterId?: string; // ✨ [Added] 方便前端直接使用 ID 渲染组件
  telegram?: string;
  website?: string;
  paidOnDexScreener: boolean; // 📢 是否买广告

  // --- 其他 ---
  narrative?: string;   // 叙事描述
  sensitiveToken: boolean; // ⚠️ 敏感代币
  exclusive: boolean;
  decimal: number;

  source: 'meme-rush';
}

// ----------------------------------------------------------------------------
// 4. WebSocket 推送载荷 (Union Type)
// ----------------------------------------------------------------------------
export type DataPayload =
  | { category: 'hotlist'; type: 'snapshot' | 'update'; data: HotlistItem[] }
  | { category: 'meme_new'; type: 'snapshot' | 'update'; data: MemeItem[] };

export type MarketItem = HotlistItem | MemeItem;