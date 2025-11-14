// packages/frontend/src/chart.tsx
/* @refresh reload */
import { render } from 'solid-js/web';
import './css/base.css';
import './css/chart-layout.css';
import './css/rankings.css';
import './css/chart-grid.css';
import './css/single-token-view.css'; // 导入新的 CSS 文件
import ChartPageLayout from './ChartPageLayout';

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element #root not found in chart.html. Or maybe the id attribute got misspelled?',
  );
}

render(() => <ChartPageLayout />, root!);