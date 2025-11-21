// packages/frontend/src/TokenPageLayout.tsx
/** @jsxImportSource solid-js */
import { Component, createSignal, onMount, onCleanup, createEffect, Show, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from './socket';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import SingleTokenView from './SingleTokenView';
import { PRESET_THEMES } from './themes';

const BLOCKLIST_STORAGE_KEY = 'trading-dashboard-blocklist';

const TIMEFRAME_MAP: Record<string, string> = {
  '1': '1m', '2': '5m', '3': '1h', '4': '4h', '5': '1d',
};

// Logger helper
const log = (msg: string, ...args: any[]) => {
  console.log(`[TokenPageLayout] ${msg}`, ...args);
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
  const [marketData, setMarketData] = createStore<MarketItem[]>([]);
  const [lastUpdate, setLastUpdate] = createSignal('Connecting...');
  const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());
  const [currentToken, setCurrentToken] = createSignal<MarketItem | null>(null);
  const [activeTimeframe, setActiveTimeframe] = createSignal('5m');

  // 初始化主题状态 (默认使用第一个主题，支持快捷键切换)
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
    
    // 支持 'T' 键切换主题
    if (e.key.toLowerCase() === 't') {
      setThemeIndex((prev) => {
        const next = (prev + 1) % PRESET_THEMES.length;
        log('Theme switched to index:', next);
        return next;
      });
      return;
    }

    if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
      const newTimeframe = TIMEFRAME_MAP[e.key];
      log(`Timeframe switched via key ${e.key} to ${newTimeframe}`);
      setActiveTimeframe(newTimeframe);
    }
  };

  onMount(() => {
    log('Mounted. Initializing socket and listeners.');
    if (!socket.connected) socket.connect();

    socket.on('data-broadcast', (payload: DataPayload) => {
        if (!payload.data || payload.data.length === 0) return;
        
        setMarketData(produce(currentData => {
            for (const item of payload.data) {
                const index = currentData.findIndex(d => d.contractAddress === item.contractAddress && d.chain === item.chain);
                if (index > -1) {
                    Object.assign(currentData[index], item);
                } else {
                    currentData.push(item);
                }
            }
        }));
        setLastUpdate(new Date().toLocaleTimeString());
    });

    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyDown);
      log('Cleaned up event listeners.');
    });
  });

  // Effect to handle URL params and data matching
  createEffect(() => {
    const params = getTokenParamsFromURL();
    // 只有当有市场数据且URL参数存在时才尝试匹配
    if (marketData.length > 0 && params) {
        const current = currentToken();
        // 如果当前已经选中了token，并且地址和URL一致，只更新数据
        if (current && 
            current.contractAddress.toLowerCase() === params.address.toLowerCase() && 
            current.chain.toLowerCase() === params.chain.toLowerCase()) {
            
            const updatedTokenData = marketData.find(t => t.contractAddress === current.contractAddress);
            if (updatedTokenData) {
                // 保持引用更新（如果是 Store 的一部分，这里可能不需要手动 set，视 Store 实现而定，
                // 但为了确保 SingleTokenView 拿到最新对象，显式 set 比较稳妥）
                setCurrentToken(updatedTokenData); 
            }
            return;
        }

        // 如果是第一次加载或者 URL 变了，寻找对应的 Token
        const foundToken = marketData.find(t => 
            t.contractAddress.toLowerCase() === params.address.toLowerCase() &&
            t.chain.toLowerCase() === params.chain.toLowerCase()
        );

        if (foundToken) {
            log('Found token from URL params:', foundToken.symbol);
            setCurrentToken(foundToken);
        } else {
            // 这里可以加个日志，说明没找到数据还在等待
            // log('Waiting for market data to match URL params...');
        }
    }
  });

  const handleTokenSelect = (token: MarketItem) => {
    log('Token selected from list:', token.symbol);
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
            "border-right": `1px solid ${currentTheme().grid.vertLines}`, // 增加边框分割感
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
          theme={currentTheme()} // 修复: 传递 theme
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
                    Select a token from the list on the left or provide address/chain in URL.
                </div>
            }
        >
          <SingleTokenView 
            token={currentToken()!} 
            activeTimeframe={activeTimeframe()}
            theme={currentTheme()} // 修复: 传递 theme
          />
        </Show>
      </div>
    </div>
  );
};

export default TokenPageLayout;