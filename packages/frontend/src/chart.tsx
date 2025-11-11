// packages/frontend/src/chart.tsx
/* @refresh reload */
import { render } from 'solid-js/web';
import './index.css';
import MultiChartGrid from './MultiChartGrid';

// 渲染到新的容器 ID
const gridContainer = document.getElementById('chart-grid-container');

if (import.meta.env.DEV && !(gridContainer instanceof HTMLElement)) {
  throw new Error(
    'Grid container #chart-grid-container not found in chart.html. Or maybe the id attribute got misspelled?',
  );
}

// 渲染网格组件
render(() => <MultiChartGrid />, gridContainer!);