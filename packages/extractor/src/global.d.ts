// packages/extractor/src/global.d.ts
declare global {
  // --- 为 browser-script.ts 提供的自包含、全局的类型定义 ---

  /**
   * 核心的市场数据项结构
   * (此定义与 shared-types 重复，专为非模块化的浏览器脚本服务)
   */
  interface MarketItem {
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
   * 注入浏览器的脚本回传给 Playwright 的数据结构
   * (此定义与 shared-types 重复)
   */
  interface ExtractedDataPayload {
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
   * 传递给浏览器脚本的配置项
   */
  interface ExtractorOptions {
    selectors: { stableContainer: string };
    interval: number;
    config: {
      minArrayLength: number;
      requiredKeys: string[];
      maxFiberTreeDepth: number;
    };
    desiredFields: string[];
  }
  
  // --- 挂载到 window 对象上的属性 ---

  interface Window {
    // 从 Playwright 暴露的函数
    onDataExtracted: (payload: ExtractedDataPayload) => void;
    // 为了安全日志而备份的原始 console.log
    originalConsoleLog: (...args: any[]) => void;
    // 附加到 window 上的初始化函数
    initializeExtractor: (options: ExtractorOptions) => void;
  }
}


export {}