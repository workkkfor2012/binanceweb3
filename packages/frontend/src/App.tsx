// packages/frontend/src/App.tsx
import { createSignal, onMount, onCleanup, For, Component, JSX } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
// 从共享包导入类型!
import type { MarketItem, DataPayload } from 'shared-types';

const BACKEND_URL = 'http://localhost:3001';

// --- 辅助函数区 ---

// 将程序化的字段名转换为更友好的中文表头
const FIELD_DISPLAY_NAMES: Record<string, string> = {
  icon: '图标',
  symbol: '品种',
  price: '价格',
  marketCap: '市值',
  chainId: '链 ID',
  contractAddress: '合约地址',
  volume1m: '成交量 (1m)',
  volume5m: '成交量 (5m)',
  volume1h: '成交量 (1h)',
  volume4h: '成交量 (4h)',
  volume24h: '成交量 (24h)',
  priceChange1m: '价格变化 (1m)',
  priceChange5m: '价格变化 (5m)',
  priceChange1h: '价格变化 (1h)',
  priceChange4h: '价格变化 (4h)',
  priceChange24h: '价格变化 (24h)',
};

// 格式化价格
const formatPrice = (price: number | null | undefined): string => {
  if (price === null || price === undefined) return 'N/A';
  if (price < 0.001) return price.toPrecision(4);
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
};

// 格式化百分比变化
const formatPercentage = (change: string | number | null | undefined): JSX.Element => {
  if (change === null || change === undefined) return <span class="na">N/A</span>;
  const value = parseFloat(String(change));
  const changeClass = value >= 0 ? 'positive' : 'negative';
  return <span class={changeClass}>{`${value.toFixed(2)}%`}</span>;
};

// 格式化成交量或市值
const formatVolumeOrMarketCap = (num: number | null | undefined): string => {
  if (num === null || num === undefined) return 'N/A';
  return `$${num.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
};

// --- “全功能” MarketRow 组件 ---
// 这个组件显式渲染所有16个字段
interface MarketRowProps {
  item: MarketItem;
}

const MarketRow: Component<MarketRowProps> = (props) => {
  const { item } = props;
  const proxiedIconUrl = () => `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon)}`;

  return (
    <tr>
      <td><img src={proxiedIconUrl()} alt={item.symbol} class="icon" /></td>
      <td>{item.symbol}</td>
      <td>{formatPrice(item.price)}</td>
      <td>{formatPercentage(item.priceChange24h)}</td>
      <td>{formatVolumeOrMarketCap(item.volume24h)}</td>
      <td>{formatVolumeOrMarketCap(item.marketCap)}</td>
      <td>{item.chainId}</td>
      <td title={item.contractAddress}>{`${String(item.contractAddress).substring(0, 6)}...`}</td>
      <td>{formatPercentage(item.priceChange1m)}</td>
      <td>{formatPercentage(item.priceChange5m)}</td>
      <td>{formatPercentage(item.priceChange1h)}</td>
      <td>{formatPercentage(item.priceChange4h)}</td>
      <td>{formatVolumeOrMarketCap(item.volume1m)}</td>
      <td>{formatVolumeOrMarketCap(item.volume5m)}</td>
      <td>{formatVolumeOrMarketCap(item.volume1h)}</td>
      <td>{formatVolumeOrMarketCap(item.volume4h)}</td>
    </tr>
  );
};


const App: Component = () => {
  const [status, setStatus] = createSignal<'connecting...' | 'connected' | 'disconnected'>('connecting...');
  const [lastUpdate, setLastUpdate] = createSignal('N/A');
  const [marketData, setMarketData] = createStore<MarketItem[]>([]);
  // desiredFields 仍用于动态生成表头
  const [desiredFields, setDesiredFields] = createSignal<string[]>([]);

  onMount(() => {
    // 获取被监控的字段列表
    const fetchDesiredFields = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/desired-fields`);
        if (!response.ok) throw new Error('Network response was not ok');
        const fields: string[] = await response.json();
        
        // 我们可以控制字段的显示顺序，以确保关键信息在前
        const preferredOrder = [
            'icon', 'symbol', 'price', 'priceChange24h', 'volume24h', 'marketCap', 
            'chainId', 'contractAddress',
            'priceChange1m', 'priceChange5m', 'priceChange1h', 'priceChange4h',
            'volume1m', 'volume5m', 'volume1h', 'volume4h'
        ];
        
        // 使用 Set 来确保唯一性，并按照 preferredOrder 排序
        const orderedFields = [...new Set([...preferredOrder, ...fields.filter(f => preferredOrder.includes(f))])];
        setDesiredFields(orderedFields);

      } catch (error) {
        console.error("Failed to fetch desired fields:", error);
      }
    };
    
    fetchDesiredFields();

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

    onCleanup(() => socket.disconnect());
  });

  return (
    <>
      <h1>实时市场数据监控 (SolidJS + Vite + TS)</h1>
      <div class="stats">
        <p>状态: <span class={status()}>{status()}</span></p>
        <p>最后更新: <span>{lastUpdate()}</span></p>
        <p>品种总数: <span>{marketData.length}</span></p>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              {/* 表头仍然是动态的，以确保与 MarketRow 的列顺序一致 */}
              <For each={desiredFields()}>
                {(field) => <th>{FIELD_DISPLAY_NAMES[field] || field}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            {/* 使用我们新的、全功能的 MarketRow 组件 */}
            <For each={marketData} fallback={<tr><td colspan={desiredFields().length || 1}>等待数据...</td></tr>}>
              {(item) => <MarketRow item={item} />}
            </For>
          </tbody>
        </table>
      </div>
    </>
  );
};

export default App;