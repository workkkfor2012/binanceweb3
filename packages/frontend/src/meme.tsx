// packages/frontend/src/meme.tsx
/* @refresh reload */
import { render } from 'solid-js/web';
import './css/base.css';
import './css/dashboard.css';
// 你可以复用 dashboard.css，也可以为 meme 单独写样式
import MemePage from './MemePage';

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?',
  );
}

render(() => <MemePage />, root!);