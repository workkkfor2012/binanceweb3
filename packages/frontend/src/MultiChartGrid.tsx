// packages/frontend/src/MultiChartGrid.tsx
import { Component, For, createMemo } from 'solid-js';
import SingleKlineChart from './SingleKlineChart';
import type { MarketItem } from 'shared-types';
// ✨ 核心修改 1: 导入 LogicalRange
import type { LogicalRange } from 'lightweight-charts';


// ✨ 核心修改 2: 更新 Props 接口
interface MultiChartGridProps {
    tokens: MarketItem[];
    onBlockToken: (contractAddress: string) => void;
    timeframe: string;
    visibleLogicalRange: LogicalRange | null;
    onVisibleLogicalRangeChange: (range: LogicalRange) => void;
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
            // ✨ 核心修改 3: 传递新的 props
            visibleLogicalRange={props.visibleLogicalRange}
            onVisibleLogicalRangeChange={props.onVisibleLogicalRangeChange}
            activeChartId={props.activeChartId}
            onSetActiveChart={props.onSetActiveChart}
          />
        )}
      </For>
    </div>
  );
};

export default MultiChartGrid;