// packages/frontend/src/MultiChartGrid.tsx
import { For } from 'solid-js';
import SingleKlineChart from './SingleKlineChart';

const MultiChartGrid = () => {
  // 创建一个长度为 9 的数组用于循环
  const charts = Array.from({ length: 9 });

  return (
    <For each={charts}>
      {() => <SingleKlineChart />}
    </For>
  );
};

export default MultiChartGrid;