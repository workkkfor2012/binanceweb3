// packages/frontend/src/MultiChartGrid.tsx
import { Component, For, createMemo } from 'solid-js';
import SingleKlineChart from './SingleKlineChart';
import type { MarketItem } from 'shared-types';

// ✨ 修改: 定义Props接口
interface MultiChartGridProps {
    tokens: MarketItem[];
    onBlockToken: (contractAddress: string) => void;
}

const MultiChartGrid: Component<MultiChartGridProps> = (props) => {
  const chartData = createMemo(() => {
    const currentTokens = props.tokens || [];
    return Array.from({ length: 9 }).map((_, i) => currentTokens[i]);
  });

  return (
    <div id="chart-grid-container">
      {/* ✨ 修改: 循环渲染9个图表，并传入 onBlock 函数 */}
      <For each={chartData()}>
        {(token) => <SingleKlineChart tokenInfo={token} onBlock={props.onBlockToken} />}
      </For>
    </div>
  );
};

export default MultiChartGrid;