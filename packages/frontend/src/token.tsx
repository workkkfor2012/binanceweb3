// packages/frontend/src/token.tsx
/** @jsxImportSource solid-js */
/* @refresh reload */
import { render } from 'solid-js/web';
import './css/base.css';
import './css/chart-layout.css';
import './css/rankings.css';
import './css/single-token-view.css'; 
import './css/chart-grid.css'; // ✨ 核心修复：导入缺失的关键样式文件
import TokenPageLayout from './TokenPageLayout'; 

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element #root not found in token.html. Or maybe the id attribute got misspelled?',
  );
}

render(() => <TokenPageLayout />, root!);