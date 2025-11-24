// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup, createMemo, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from './socket';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import MultiChartGrid from './MultiChartGrid';
import SingleTokenView from './SingleTokenView';
import { initializeVoices, checkAndTriggerAlerts } from './AlertManager';
import { PRESET_THEMES } from './themes';

// ✨ [Refactor] 核心修改: 将同步状态改为 Logical Range (逻辑索引)
export interface ViewportState {
  from: number; // Logical Index (float)
  to: number; // Logical Index (float)
}

const BLOCKLIST_STORAGE_KEY = 'trading-dashboard-blocklist';

const TIMEFRAME_MAP: Record<string, string> = {
  '1': '1m', '2': '5m', '3': '1h', '4': '4h', '5': '1d',
};
export const ALL_TIMEFRAMES = Object.values(TIMEFRAME_MAP);

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

const saveBlockListToStorage = (blockList: Set<string>): void => {
  try {
    localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(Array.from(blockList)));
  } catch (error) { console.error('[Blocklist] Failed to save blocklist:', error); }
};

const ChartPageLayout: Component = () => {
  const [marketData, setMarketData] = createStore<MarketItem[]>([]);
  const [lastUpdate, setLastUpdate] = createSignal('Connecting...');
  
  // ✨ 修改: 默认排序改为 'priceChange5m'，因为成交额排名已被移除
  const [activeRankBy, setActiveRankBy] = createSignal<keyof MarketItem | null>('priceChange5m');
  
  const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());
  const [activeTimeframe, setActiveTimeframe] = createSignal(ALL_TIMEFRAMES[0]);
  
  // 同步状态信号
  const [viewportState, setViewportState] = createSignal<ViewportState | null>(null);
  const [activeChartId, setActiveChartId] = createSignal<string | null>(null);

  const [viewMode, setViewMode] = createSignal<'grid' | 'single'>('grid');
  const [focusedToken, setFocusedToken] = createSignal<MarketItem | null>(null);
  
  // ✨ Theme State
  const [themeIndex, setThemeIndex] = createSignal(0);
  const currentTheme = createMemo(() => PRESET_THEMES[themeIndex()]);

  const handleViewportChange = (newState: ViewportState | null) => {
    setViewportState(newState);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // ✨ Theme Switching Hotkey
    if (e.key.toLowerCase() === 't') {
        setThemeIndex((prev) => (prev + 1) % PRESET_THEMES.length);
        console.log(`[Layout] Theme changed to: ${PRESET_THEMES[themeIndex()].name}`);
        return;
    }

    if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
        const newTimeframe = TIMEFRAME_MAP[e.key];
        setActiveTimeframe(newTimeframe);
        if (viewMode() === 'grid') {
            setViewportState(null);
        }
        return;
    }

    if (e.key.toLowerCase() === 'f') {
        if (viewMode() === 'grid') {
            const hoveredTokenId = activeChartId();
            if (hoveredTokenId) {
                const token = rankedTokensForGrid().find(t => t.contractAddress === hoveredTokenId);
                if (token) {
                    setFocusedToken(token);
                    setViewMode('single');
                }
            }
        } else {
            setViewMode('grid');
            setFocusedToken(null);
        }
    }
  };

  const handleNewAlert = (logMessage: string, alertType: 'volume' | 'price') => {
    console.log(`[ChartPage Alert] [${alertType.toUpperCase()}] ${logMessage}`);
  };

  onMount(() => {
    if (!socket.connected) socket.connect();

    socket.on('connect', () => setLastUpdate('Connected, waiting for data...'));
    socket.on('disconnect', () => setLastUpdate('Disconnected'));
    socket.on('data-broadcast', (payload: DataPayload) => {
        if (!payload.data || payload.data.length === 0) return;
        const blocked = blockList();
        
        for (const newItem of payload.data) {
            if (!blocked.has(newItem.contractAddress)) {
                const oldItem = marketData.find(d => 
                    d.contractAddress === newItem.contractAddress && d.chain === newItem.chain
                );
                if (oldItem) {
                    checkAndTriggerAlerts(newItem, oldItem, handleNewAlert);
                }
            }
        }

        setMarketData(produce(currentData => {
            for (const item of payload.data) {
                const index = currentData.findIndex(d => d.contractAddress === item.contractAddress && d.chain === item.chain);
                if (index > -1) Object.assign(currentData[index], item);
                else currentData.push(item);
            }
        }));
        setLastUpdate(new Date().toLocaleTimeString());
    });

    initializeVoices();
    window.addEventListener('keydown', handleKeyDown);

    onCleanup(() => {
        socket.off('connect');
        socket.off('disconnect');
        socket.off('data-broadcast');
        window.removeEventListener('keydown', handleKeyDown);
    });
  });

  const handleBlockToken = (contractAddress: string) => {
    const newBlockList = new Set(blockList());
    newBlockList.add(contractAddress);
    setBlockList(newBlockList);
    saveBlockListToStorage(newBlockList);
  };

  const rankedTokensForGrid = createMemo(() => {
    const rankBy = activeRankBy();
    const blocked = blockList();
    if (!rankBy) return [];
    return [...marketData]
      .filter(item => !blocked.has(item.contractAddress))
      .filter(item => item.icon && item[rankBy] != null)
      .sort((a, b) => {
        const valA = a[rankBy]!;
        const valB = b[rankBy]!;
        return (typeof valB === 'string' ? parseFloat(valB) : valB) -
               (typeof valA === 'string' ? parseFloat(valA) : valA);
      })
      .slice(0, 9);
  });

  const handleRankingHeaderClick = (rankBy: keyof MarketItem) => {
    setActiveRankBy(rankBy);
  };

  const handleRankingItemClick = (item: MarketItem) => {
    const url = `/token.html?address=${item.contractAddress}&chain=${item.chain}`;
    window.open(url, '_blank');
  };

  return (
    <div 
        class="chart-page-container" 
        style={{ 
            "background-color": currentTheme().layout.background, // ✨ 全局背景
            "color": currentTheme().layout.textColor // ✨ 全局字体颜色
        }}
    >
      <div 
        class="left-sidebar"
        style={{
            "background-color": currentTheme().layout.background, // ✨ 侧边栏背景
            "border-color": currentTheme().grid.vertLines, // ✨ 侧边栏边框，使用网格线颜色作为分割线
            "color": currentTheme().layout.textColor
        }}
      >
        <CompactRankingListsContainer
          marketData={marketData}
          lastUpdate={lastUpdate()}
          onHeaderClick={handleRankingHeaderClick}
          blockList={blockList()}
          onItemClick={handleRankingItemClick}
          theme={currentTheme()} // ✨ 传递主题
        />
      </div>
      
      <div class="right-chart-grid">
        <Show
          when={viewMode() === 'single' && focusedToken()}
          fallback={
            <>
              <div class="grid-header" style={{ "color": currentTheme().layout.textColor }}>
                <div class="active-timeframe-indicator">
                  <span>Timeframe: </span>
                  <strong>{activeTimeframe().toUpperCase()}</strong>
                  <span class="hotkey-hint" style={{ opacity: 0.6 }}>(Keys: 1-5)</span>
                  
                  <span style={{ "margin-left": "15px" }}>Theme: </span>
                  <strong>{currentTheme().name}</strong>
                  <span class="hotkey-hint" style={{ opacity: 0.6 }}>(Key: T)</span>
                </div>
              </div>
              <MultiChartGrid
                tokens={rankedTokensForGrid()}
                onBlockToken={handleBlockToken}
                timeframe={activeTimeframe()}
                viewportState={viewportState()}
                onViewportChange={handleViewportChange}
                activeChartId={activeChartId()}
                onSetActiveChart={setActiveChartId}
                theme={currentTheme()} // ✨ 传递主题
              />
            </>
          }
        >
          <SingleTokenView
            token={focusedToken()!}
            activeTimeframe={activeTimeframe()}
            theme={currentTheme()} // ✨ 传递主题
          />
        </Show>
      </div>
    </div>
  );
};

export default ChartPageLayout;