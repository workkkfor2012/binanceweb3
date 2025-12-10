// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup, createMemo, Show } from 'solid-js';
import type { MarketItem } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import MultiChartGrid from './MultiChartGrid';
import SingleTokenView from './SingleTokenView';
import { initializeVoices } from './AlertManager';
import { PRESET_THEMES } from './themes';
import { useMarketData } from './hooks/useMarketData'; // ✨ 引入 Hook

export interface ViewportState {
  from: number;
  to: number;
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
  // ✨ 修复：显式传入 'hotlist' 作为分类
  const { marketData, connectionStatus, lastUpdate } = useMarketData('hotlist');

  // UI 状态
  const [activeRankBy, setActiveRankBy] = createSignal<keyof MarketItem | null>('priceChange5m');
  const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());
  const [activeTimeframe, setActiveTimeframe] = createSignal(ALL_TIMEFRAMES[0]);

  // 视图与焦点状态
  const [viewportState, setViewportState] = createSignal<ViewportState | null>(null);
  const [activeChartId, setActiveChartId] = createSignal<string | null>(null);
  const [viewMode, setViewMode] = createSignal<'grid' | 'single'>('grid');
  const [focusedToken, setFocusedToken] = createSignal<MarketItem | null>(null);

  // 主题状态
  const [themeIndex, setThemeIndex] = createSignal(0);
  const currentTheme = createMemo(() => PRESET_THEMES[themeIndex()]);

  const handleViewportChange = (newState: ViewportState | null) => {
    setViewportState(newState);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key.toLowerCase() === 't') {
      setThemeIndex((prev) => (prev + 1) % PRESET_THEMES.length);
      console.log(`[Layout] 🎨 Theme changed to: ${PRESET_THEMES[(themeIndex() + 1) % PRESET_THEMES.length].name}`);
      return;
    }

    if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
      const newTimeframe = TIMEFRAME_MAP[e.key];
      setActiveTimeframe(newTimeframe);
      if (viewMode() === 'grid') setViewportState(null);
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

  onMount(() => {
    console.log('[ChartPage] 🚀 Component Mounted');
    initializeVoices();
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
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
      .filter(item => item[rankBy] != null && String(item[rankBy]).trim() !== '')
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
        "background-color": currentTheme().layout.background,
        "color": currentTheme().layout.textColor
      }}
    >
      <div
        class="left-sidebar"
        style={{
          "background-color": currentTheme().layout.background,
          "border-color": currentTheme().grid.vertLines,
          "color": currentTheme().layout.textColor
        }}
      >
        <CompactRankingListsContainer
          marketData={marketData}
          lastUpdate={lastUpdate()}
          onHeaderClick={handleRankingHeaderClick}
          blockList={blockList()}
          onItemClick={handleRankingItemClick}
          theme={currentTheme()}
        />
        <div style={{ "padding": "10px", "font-size": "0.8em", "opacity": 0.6, "text-align": "center" }}>
          Status: {connectionStatus()}
        </div>
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
                  <span class="hotkey-hint" style={{ opacity: 0.6 }}> (Keys: 1-5)</span>

                  <span style={{ "margin-left": "15px" }}>Theme: </span>
                  <strong>{currentTheme().name}</strong>
                  <span class="hotkey-hint" style={{ opacity: 0.6 }}> (Key: T)</span>
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
                theme={currentTheme()}
              />
            </>
          }
        >
          <SingleTokenView
            token={focusedToken()!}
            activeTimeframe={activeTimeframe()}
            theme={currentTheme()}
          />
        </Show>
      </div>
    </div>
  );
};

export default ChartPageLayout;