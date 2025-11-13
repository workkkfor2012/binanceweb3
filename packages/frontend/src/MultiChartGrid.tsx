// packages/frontend/src/MultiChartGrid.tsx
import { Component, For, createMemo } from 'solid-js';
import SingleKlineChart from './SingleKlineChart';
import type { MarketItem } from 'shared-types';

// ✨ 新增: 定义Props接口
interface MultiChartGridProps {
    tokens: MarketItem[];
}

const MultiChartGrid: Component<MultiChartGridProps> = (props) => {
  // ✨ 修改: 创建一个长度为9的数组，用传入的tokens填充，不足部分为undefined
  // 这能确保网格始终有9个元素，避免UI在刷新时闪烁
  const chartData = createMemo(() => {
    const currentTokens = props.tokens || [];
    return Array.from({ length: 9 }).map((_, i) => currentTokens[i]);
  });

  return (
    <div id="chart-grid-container">
      {/* ✨ 修改: 循环渲染9个图表，并传入tokenInfo */}
      <For each={chartData()}>
        {(token) => <SingleKlineChart tokenInfo={token} />}
      </For>
    </div>
  );
};

export default MultiChartGrid;