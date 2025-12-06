// packages/frontend/src/TokenPageLayout.tsx
/** @jsxImportSource solid-js */
import { Component, createSignal, onMount, onCleanup, createEffect, Show, createMemo } from 'solid-js';
import type { MarketItem } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import SingleTokenView from './SingleTokenView';
import { PRESET_THEMES } from './themes';
import { useMarketData } from './hooks/useMarketData';

const BLOCKLIST_STORAGE_KEY = 'trading-dashboard-blocklist';

const TIMEFRAME_MAP: Record<string, string> = {
  '1': '1m', '2': '5m', '3': '1h', '4': '4h', '5': '1d',
};

// Logger helper
const log = (msg: string, ...args: any[]) => {
  console.log(`[TokenPage] ${msg}`, ...args);
};

const loadBlockListFromStorage = (): Set<string> => {
  try {
    const storedList = localStorage.getItem(BLOCKLIST_STORAGE_KEY);
    if (storedList) {
      const parsedArray = JSON.parse(storedList);
      if (Array.isArray(parsedArray)) return new Set(parsedArray);
    }
  } catch (error) { console.error('[Blocklist] Failed to load blocklist:', error); }
  return new Set();
};

const TokenPageLayout: Component = () => {
  // 获取 Hotlist 数据，用于左侧列表
  const { marketData, lastUpdate } = useMarketData('hotlist');
  
  const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());
  
  // ✨ 核心修改：currentToken 初始值不再依赖 hotlist 查找
  const [currentToken, setCurrentToken] = createSignal<MarketItem | null>(null);
  const [activeTimeframe, setActiveTimeframe] = createSignal('5m');

  const [themeIndex, setThemeIndex] = createSignal(0);
  const currentTheme = createMemo(() => PRESET_THEMES[themeIndex()]);

  // 辅助：从 URL 获取参数
  const getTokenParamsFromURL = () => {
    const params = new URLSearchParams(window.location.search);
    const address = params.get('address');
    const chain = params.get('chain');
    return (address && chain) ? { address, chain } : null;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    
    if (e.key.toLowerCase() === 't') {
      setThemeIndex((prev) => (prev + 1) % PRESET_THEMES.length);
      return;
    }

    if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
      const newTimeframe = TIMEFRAME_MAP[e.key];
      setActiveTimeframe(newTimeframe);
    }
  };

  // 1. 初始化挂载
  onMount(() => {
    log('🚀 Mounting TokenPageLayout...');
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));

    // ✨ 核心逻辑修复：页面加载时，只要 URL 有参数，立即构造对象，不等待 Hotlist
    const params = getTokenParamsFromURL();
    if (params) {
        log('URL params found, forcing initial render:', params);
        const stubToken = createStubToken(params.address, params.chain);
        setCurrentToken(stubToken);
    }
  });

  // 辅助：创建一个“临时身份卡”
  const createStubToken = (address: string, chain: string): MarketItem => {
    return {
        contractAddress: address,
        chain: chain,
        symbol: `${address.substring(0, 4)}...${address.substring(address.length - 4)}`, // 临时显示缩略地址
        name: 'Loading...',
        price: 0,
        priceChange24h: 0,
        volume24h: 0,
        marketCap: 0,
        liquidity: 0,
        icon: '', // 无图标
        source: 'url_stub' // 标记来源
    } as any;
  };

  // 2. 监听 URL 变化或 Hotlist 数据更新
  createEffect(() => {
    const params = getTokenParamsFromURL();
    
    if (params) {
        // 尝试在 Hotlist 中找详细信息
        const foundInHotlist = marketData.find(t => 
            t.contractAddress.toLowerCase() === params.address.toLowerCase() &&
            t.chain.toLowerCase() === params.chain.toLowerCase()
        );

        if (foundInHotlist) {
            // ✅ 情况 A: Hotlist 里有，用详细信息更新（有图标、名字）
            const current = currentToken();
            // 防止重复更新导致图表闪烁：只有当对象引用真的变了，或者之前是临时卡时才更新
            if (!current || current.source === 'url_stub' || current.contractAddress !== foundInHotlist.contractAddress) {
                 log('Enriching token data from Hotlist:', foundInHotlist.symbol);
                 setCurrentToken(foundInHotlist);
            }
        } else {
            // ✅ 情况 B: Hotlist 里没有（比如冷门币，或者 socket 还没连上）
            // 确保 currentToken 至少有一个基于 URL 的临时对象，保证 K 线组件不被卸载
            const current = currentToken();
            if (!current || current.contractAddress.toLowerCase() !== params.address.toLowerCase()) {
                log('Token not in hotlist, creating stub from URL');
                setCurrentToken(createStubToken(params.address, params.chain));
            }
        }
    }
  });

  const handleTokenSelect = (token: MarketItem) => {
    log('User selected token:', token.symbol);
    const newUrl = `/token.html?address=${token.contractAddress}&chain=${token.chain}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
    // 强制更新当前 token
    setCurrentToken(token);
  };

  return (
    <div 
        class="chart-page-container"
        style={{
            "background-color": currentTheme().layout.background,
            "color": currentTheme().layout.textColor,
            "height": "100vh",
            "display": "flex",
            "overflow": "hidden"
        }}
    >
      <div 
        class="left-sidebar"
        style={{
            "background-color": currentTheme().layout.background,
            "border-right": `1px solid ${currentTheme().grid.vertLines}`,
            "color": currentTheme().layout.textColor,
            "width": "350px",
            "flex-shrink": 0,
            "display": "flex",
            "flex-direction": "column"
        }}
      >
        <CompactRankingListsContainer 
          marketData={marketData}
          lastUpdate={lastUpdate()} 
          onHeaderClick={() => {}}
          blockList={blockList()}
          onItemClick={handleTokenSelect}
          theme={currentTheme()}
        />
      </div>
      <div 
        class="right-chart-grid"
        style={{
            "flex-grow": 1,
            "position": "relative",
            "overflow": "hidden"
        }}
      >
        <Show 
            when={currentToken()} 
            fallback={
                <div 
                    class="placeholder" 
                    style={{ 
                        "color": currentTheme().layout.textColor,
                        "display": "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        "height": "100%"
                    }}
                >
                    Waiting for data... (Check URL params)
                </div>
            }
        >
          <SingleTokenView 
            token={currentToken()!} 
            activeTimeframe={activeTimeframe()}
            theme={currentTheme()}
          />
        </Show>
      </div>
    </div>
  );
};

export default TokenPageLayout;