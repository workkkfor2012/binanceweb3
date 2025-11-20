// packages/frontend/src/MultiChartGrid.tsx
import { Component, For, createMemo } from 'solid-js';
import SingleKlineChart from './SingleKlineChart';
import type { MarketItem } from 'shared-types';
import type { ViewportState } from './ChartPageLayout';
import type { ChartTheme } from './themes';

interface MultiChartGridProps {
  tokens: MarketItem[];
  onBlockToken: (contractAddress: string) => void;
  timeframe: string;
  viewportState: ViewportState | null;
  onViewportChange: (state: ViewportState | null) => void;
  activeChartId: string | null;
  onSetActiveChart: (id: string | null) => void;
  theme: ChartTheme; // ✨ Receive Theme
}

const MultiChartGrid: Component<MultiChartGridProps> = (props) => {
  const chartData = createMemo(() => {
    const currentTokens = props.tokens || [];
    return Array.from({ length: 9 }).map((_, i) => currentTokens[i]);
  });

  return (
    <div 
        id="chart-grid-container"
        style={{
            // ✨ 使用主题的网格线颜色作为 9 宫格的缝隙颜色
            "background-color": props.theme.grid.vertLines, 
            "border-color": props.theme.grid.vertLines 
        }}
    >
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
                    showAxes={true}
                    theme={props.theme} // ✨ Pass Theme
                />
            )}
        </For>
    </div>
  );
};

export default MultiChartGrid;