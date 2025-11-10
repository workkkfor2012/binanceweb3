// packages/frontend/src/chart.tsx
/* @refresh reload */
import { render } from 'solid-js/web';
import './index.css';
import KlineChart from './KlineChart';

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found in chart.html. Or maybe the id attribute got misspelled?',
  );
}

render(() => <KlineChart />, root!);