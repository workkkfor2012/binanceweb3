// packages/frontend/src/App.tsx
import { createSignal, onMount, onCleanup, For, Component } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
// 从共享包导入类型!
import type { MarketItem, DataPayload } from 'shared-types';

const BACKEND_URL = 'http://localhost:3001';

// --- 组件 ---
interface MarketRowProps {
  item: MarketItem;
}

const MarketRow: Component<MarketRowProps> = (props) => {
  const { item } = props;

  const priceChangeClass = () => {
    const change = parseFloat(item.priceChange24h);
    return change >= 0 ? 'positive' : 'negative';
  };

  const formatNumber = (num: number | null | undefined): string => {
    if (num === null || num === undefined) return 'N/A';
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  };
    
  const formatPrice = (price: number | null | undefined): string => {
    if (price === null || price === undefined) return 'N/A';
    if (price < 0.001) {
         return price.toPrecision(4);
    }
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  };

  const proxiedIconUrl = () => `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon)}`;

  return (
    <tr>
      <td>
        <img src={proxiedIconUrl()} alt={item.symbol} class="icon" />
      </td>
      <td>{item.symbol}</td>
      <td>{formatPrice(item.price)}</td>
      <td class={priceChangeClass()}>{`${parseFloat(item.priceChange24h).toFixed(2)}%`}</td>
      <td>${formatNumber(item.volume24h)}</td>
      <td>${formatNumber(item.marketCap)}</td>
    </tr>
  );
};


const App: Component = () => {
  const [status, setStatus] = createSignal<'connecting...' | 'connected' | 'disconnected'>('connecting...');
  const [lastUpdate, setLastUpdate] = createSignal('N/A');
  const [marketData, setMarketData] = createStore<MarketItem[]>([]);

  onMount(() => {
    const socket: Socket = io(BACKEND_URL);

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));

    socket.on('data-broadcast', (payload: DataPayload) => {
      const { type, data } = payload;
      if (!data || data.length === 0) return;

      if (type === 'snapshot') {
        setMarketData(data);
      } else if (type === 'update') {
        setMarketData(produce(currentData => {
          for (const item of data) {
            const index = currentData.findIndex(d => d.contractAddress === item.contractAddress);
            if (index > -1) {
              Object.assign(currentData[index], item);
            } else {
              currentData.push(item);
            }
          }
        }));
      }
      setLastUpdate(new Date().toLocaleTimeString());
    });

    onCleanup(() => {
      socket.disconnect();
    });
  });

  return (
    <>
      <h1>实时市场数据监控 (SolidJS + Vite + TS)</h1>
      <div class="stats">
        <p>状态: <span class={status()}>{status()}</span></p>
        <p>最后更新: <span>{lastUpdate()}</span></p>
        <p>品种总数: <span>{marketData.length}</span></p>
      </div>
      <table>
        <thead>
          <tr>
            <th>图标</th>
            <th>品种</th>
            <th>价格</th>
            <th>价格变化 (24h)</th>
            <th>成交量 (24h)</th>
            <th>市值</th>
          </tr>
        </thead>
        <tbody>
          <For each={marketData} fallback={<tr><td colspan="6">等待数据...</td></tr>}>
            {(item) => <MarketRow item={item} />}
          </For>
        </tbody>
      </table>
    </>
  );
};

export default App;