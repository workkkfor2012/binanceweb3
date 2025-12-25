// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup, createMemo, Show } from 'solid-js';
import type { MarketItem } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer.jsx';
import MultiChartGrid from './MultiChartGrid.jsx';
import SingleTokenView from './SingleTokenView.jsx';
import { initializeVoices } from './AlertManager.js';
import { PRESET_THEMES } from './themes.js';
import { useMarketData } from './hooks/useMarketData.js'; // ✨ 引入 Hook

export interface ViewportState {
  from: number;
  to: number;
}

// ✨ 不再使用 localStorage，改由后端同步

const TIMEFRAME_MAP: Record<string, string> = {
  '1': '1m', '2': '5m', '3': '1h', '4': '4h', '5': '1d',
};
export const ALL_TIMEFRAMES = Object.values(TIMEFRAME_MAP);

// ✨ 已迁移至 useMarketData

const ChartPageLayout: Component = () => {
  // ✨ 修复：显式传入 'hotlist' 作为分类，并对接详细报警日志和黑名单
  const { marketData, alertLogs, blacklist, connectionStatus, lastUpdate } = useMarketData('hotlist');

  // UI 状态
  const [activeRankBy, setActiveRankBy] = createSignal<keyof MarketItem | null>('priceChange5m' as keyof MarketItem);
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
    // ✨ 发送给后端处理，后端会广播给所有客户端同步
    import('./socket').then(({ coreSocket }) => {
      coreSocket.emit('block_token', contractAddress);
    });
  };

  const rankedTokensForGrid = createMemo(() => {
    const rankBy = activeRankBy();
    const blocked = blacklist();
    if (!rankBy) return [];

    const top9 = [...marketData]
      .filter(item => !blocked.has(item.contractAddress))
      .filter(item => item[rankBy] != null && String(item[rankBy]).trim() !== '')
      .sort((a, b) => {
        const valA = a[rankBy]!;
        const valB = b[rankBy]!;
        const numA = typeof valA === 'string' ? parseFloat(valA) : valA;
        const numB = typeof valB === 'string' ? parseFloat(valB) : valB;

        if (numB !== numA) return numB - numA;
        return a.contractAddress.localeCompare(b.contractAddress);
      })
      .slice(0, 9);

    // ✨ 获取最近报警的前 7 名 (从 AlertLogEntry 中提取 item)
    // 使用去重逻辑确保同一品种不占多个报警位槽
    const alertTop7Items: MarketItem[] = [];
    const seen = new Set<string>();

    for (const log of alertLogs) {
      // ✨ 修复：AlertLogEntry 是扁平结构，直接访问属性
      const key = `${log.chain}-${log.contractAddress}`;
      if (!seen.has(key)) {
        seen.add(key);
        // 尝试从 marketData 中查找对应的完整 MarketItem
        const fullItem = top9.find(item =>
          item.chain === log.chain && item.contractAddress === log.contractAddress
        ) || marketData.find(item =>
          item.chain === log.chain && item.contractAddress === log.contractAddress
        );

        if (fullItem) {
          alertTop7Items.push(fullItem);
          if (alertTop7Items.length >= 7) break;
        }
      }
    }

    // 合并为 16 个位槽
    const final16 = [...top9];

    // 填充 Top 9 的空位 (如果不足 9 个)
    while (final16.length < 9) {
      final16.push(undefined as any);
    }

    // 追加 7 个报警位槽
    const alertPart = [...alertTop7Items];
    while (alertPart.length < 7) {
      alertPart.push(undefined as any);
    }

    return [...final16, ...alertPart];
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
          alertLogs={alertLogs} // ✨ 传入报警日志
          lastUpdate={lastUpdate()}
          onHeaderClick={handleRankingHeaderClick}
          blockList={blacklist()}
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
                onViewportChange={setViewportState}
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