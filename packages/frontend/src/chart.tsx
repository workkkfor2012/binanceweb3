// packages/frontend/src/chart.tsx
/* @refresh reload */
import { render } from 'solid-js/web';
import './index.css';
import ChartPageLayout from './ChartPageLayout';

// 修正：寻找在 chart.html 中实际存在的根容器 'root'
const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  // 修正：更新错误信息以匹配新的目标 ID
  throw new Error(
    'Root element #root not found in chart.html. Or maybe the id attribute got misspelled?',
  );
}

// 将整个布局组件渲染到 'root' 容器中
render(() => <ChartPageLayout />, root!);