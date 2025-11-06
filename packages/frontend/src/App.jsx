// packages/frontend/src/App.jsx
import { createSignal, onMount, onCleanup, For } from 'solid-js';
import { createStore } from 'solid-js/store';
import { io } from 'socket.io-client';

const BACKEND_URL = 'http://localhost:3001';

// 单独的行组件，用于优化渲染
function MarketRow(props) {
  const item = () => props.item;

  const priceChangeClass = () => {
    const change = parseFloat(item().priceChange24h);
    return change >= 0 ? 'positive' : 'negative';
  };

  const formatNumber = (num) => {
    if (num === null || num === undefined) return 'N/A';
    return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
  };
    
  const formatPrice = (price) => {
    if (price === null || price === undefined) return 'N/A';
    if (price < 0.001) {
         return price.toPrecision(4);
    }
    return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  };

  // ✨ 变更点：图片的 src 指向我们的后端代理
  const proxiedIconUrl = () => {
    // 使用 encodeURIComponent 来确保 URL 中的特殊字符被正确编码
    return `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item().icon)}`;
  };

  return (
    <tr>
      <td>
        {/* 使用新的代理 URL */}
        <img src={proxiedIconUrl()} alt={item().symbol} class="icon" />
      </td>
      <td>{item().symbol}</td>
      <td>{formatPrice(item().price)}</td>
      <td class={priceChangeClass()}>{`${parseFloat(item().priceChange24h).toFixed(2)}%`}</td>
      <td>${formatNumber(item().volume24h)}</td>
      <td>${formatNumber(item().marketCap)}</td>
    </tr>
  );
}

function App() {
  const [status, setStatus] = createSignal('connecting...');
  const [lastUpdate, setLastUpdate] = createSignal('N/A');
  const [marketData, setMarketData] = createStore([]);

  onMount(() => {
    const socket = io(BACKEND_URL);

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));

    socket.on('data-broadcast', (payload) => {
      const { type, data } = payload;
      if (!data || data.length === 0) return;

      if (type === 'snapshot') {
        setMarketData(data);
      } else if (type === 'update') {
        for (const item of data) {
          const index = marketData.findIndex(d => d.contractAddress === item.contractAddress);
          if (index > -1) {
            setMarketData(index, item);
          } else {
            setMarketData([...marketData, item]);
          }
        }
      }
      setLastUpdate(new Date().toLocaleTimeString());
    });

    onCleanup(() => {
      socket.disconnect();
    });
  });

  return (
    <>
      <h1>实时市场数据监控 (SolidJS + Vite)</h1>
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
}

export default App;