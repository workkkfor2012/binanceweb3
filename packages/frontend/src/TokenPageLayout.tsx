// packages/frontend/src/TokenPageLayout.tsx
/** @jsxImportSource solid-js */
import { Component, createSignal, onMount, onCleanup, createEffect, Show, createMemo } from 'solid-js';
import type { MarketItem } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import SingleTokenView from './SingleTokenView';
import { PRESET_THEMES } from './themes';
import { useMarketData } from './hooks/useMarketData'; // ✨ 引入 Hook

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
  // ✨ 修复：显式传入 'hotlist' 作为分类
  const { marketData, lastUpdate } = useMarketData('hotlist');
  
  const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());
  const [currentToken, setCurrentToken] = createSignal<MarketItem | null>(null);
  const [activeTimeframe, setActiveTimeframe] = createSignal('5m');

  const [themeIndex, setThemeIndex] = createSignal(0);
  const currentTheme = createMemo(() => PRESET_THEMES[themeIndex()]);

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

  onMount(() => {
    log('🚀 Mounting TokenPageLayout...');
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });

  // Effect: 同步 URL 参数与 Store 数据
  createEffect(() => {
    const params = getTokenParamsFromURL();
    
    if (marketData.length > 0 && params) {
        const current = currentToken();
        
        // 尝试在最新的 marketData 中找到匹配项
        const foundToken = marketData.find(t => 
            t.contractAddress.toLowerCase() === params.address.toLowerCase() &&
            t.chain.toLowerCase() === params.chain.toLowerCase()
        );

        if (foundToken) {
            // 如果找到了，且引用已旧（Store更新会保持引用，但为了保险起见，或者从URL首次进入）
            if (!current || current !== foundToken) {
                 setCurrentToken(foundToken);
            }
        } else {
            if (current) log('Current token removed from backend broadcast:', current.symbol);
        }
    }
  });

  const handleTokenSelect = (token: MarketItem) => {
    log('User selected token:', token.symbol);
    const newUrl = `/token.html?address=${token.contractAddress}&chain=${token.chain}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
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
                    Waiting for data or invalid token...
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