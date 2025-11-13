// packages/frontend/src/MultiChartGrid.tsx
import { Component, For, createMemo } from 'solid-js';
import SingleKlineChart from './SingleKlineChart';
import type { MarketItem } from 'shared-types';
import type { ViewportState } from './ChartPageLayout'; // 导入新类型

interface MultiChartGridProps {
    tokens: MarketItem[];
    onBlockToken: (contractAddress: string) => void;
    timeframe: string;
    viewportState: ViewportState | null;
    onViewportChange: (state: ViewportState | null) => void;
    activeChartId: string | null;
    onSetActiveChart: (id: string | null) => void;
}

const MultiChartGrid: Component<MultiChartGridProps> = (props) => {
  const chartData = createMemo(() => {
    const currentTokens = props.tokens || [];
    return Array.from({ length: 9 }).map((_, i) => currentTokens[i]);
  });

  return (
    <div id="chart-grid-container">
      <For each={chartData()}>
        {(token) => (
          <SingleKlineChart 
            tokenInfo={token} 
            onBlock={props.onBlockToken} 
            timeframe={props.timeframe}
            viewportState={props.viewportState}
            onViewportChange={props.onViewportChange}
            activeChartId={props.activeChartId}
            onSetActiveChart={props.onSetActiveChart}
          />
        )}
      </For>
    </div>
  );
};

export default MultiChartGrid;