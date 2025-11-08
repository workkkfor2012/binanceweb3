// packages/frontend/src/App.tsx
import { createSignal, onMount, onCleanup, For, Component, JSX, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
import type { MarketItem, DataPayload } from 'shared-types';

const BACKEND_URL = 'http://localhost:3001';

// ✨ 新增: 定义可用的链，用于生成按钮
const CHAINS = ['BSC', 'Base', 'Solana'];

// --- 辅助函数区 (无变动) ---
const FIELD_DISPLAY_NAMES: Record<string, string> = {
  icon: '图标',
  symbol: '品种',
  price: '价格',
  marketCap: '市值',
  chain: '链',
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
const formatPrice = (price: number | null | undefined): string => {
  if (price === null || price === undefined) return 'N/A';
  if (price < 0.001) return price.toPrecision(4);
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
};
const formatPercentage = (change: string | number | null | undefined): JSX.Element => {
  if (change === null || change === undefined) return <span class="na">N/A</span>;
  const value = parseFloat(String(change));
  const changeClass = value >= 0 ? 'positive' : 'negative';
  return <span class={changeClass}>{`${value.toFixed(2)}%`}</span>;
};
const formatVolumeOrMarketCap = (num: number | null | undefined): string => {
  if (num === null || num === undefined) return 'N/A';
  return `$${num.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
};

// --- MarketRow 组件 (无变动) ---
// 依然显示所有字段
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
      <td>{item.chain}</td>
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
  // marketData 现在是“数据仓库”，存储所有链的数据
  const [marketData, setMarketData] = createStore<MarketItem[]>([]);
  const [desiredFields, setDesiredFields] = createSignal<string[]>([]);
  
  // ✨ 核心修改 1: 添加一个 signal 来追踪当前选择的链，默认为第一个
  const [selectedChain, setSelectedChain] = createSignal<string>(CHAINS[0]);

  // ✨ 核心修改 2: 创建一个 memoized 派生状态，用于存储过滤后的数据
  // 这非常高效，只在 marketData 或 selectedChain 变化时才重新计算
  const filteredData = createMemo(() => 
    marketData.filter(item => item.chain === selectedChain())
  );

  onMount(() => {
    const fetchDesiredFields = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/desired-fields`);
        if (!response.ok) throw new Error('Network response was not ok');
        const fields: string[] = await response.json();
        const preferredOrder = [
            'icon', 'symbol', 'chain', 'price', 'priceChange24h', 'volume24h', 'marketCap', 
            'chainId', 'contractAddress',
            'priceChange1m', 'priceChange5m', 'priceChange1h', 'priceChange4h',
            'volume1m', 'volume5m', 'volume1h', 'volume4h'
        ];
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

    // on 'data-broadcast' 的逻辑保持不变，它只负责填充我们的“数据仓库”
    socket.on('data-broadcast', (payload: DataPayload) => {
      const { type, data } = payload;
      if (!data || data.length === 0) return;

      setMarketData(produce(currentData => {
        for (const item of data) {
          const index = currentData.findIndex(d => d.contractAddress === item.contractAddress && d.chain === item.chain);
          if (index > -1) {
            Object.assign(currentData[index], item);
          } else {
            currentData.push(item);
          }
        }
      }));
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
        {/* ✨ 核心修改 3: 总数显示过滤后的数据量 */}
        <p>当前链品种总数: <span>{filteredData().length}</span></p>
      </div>

      {/* ✨ 核心修改 4: 添加链选择按钮 */}
      <div class="chain-selector">
        <For each={CHAINS}>
          {(chain) => (
            <button
              class={selectedChain() === chain ? 'active' : ''}
              onClick={() => setSelectedChain(chain)}
            >
              {chain}
            </button>
          )}
        </For>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <For each={desiredFields()}>
                {(field) => <th>{FIELD_DISPLAY_NAMES[field] || field}</th>}
              </For>
            </tr>
          </thead>
          <tbody>
            {/* ✨ 核心修改 5: 表格渲染过滤后的数据 filteredData() */}
            <For each={filteredData()} fallback={<tr><td colspan={desiredFields().length || 1}>等待数据...</td></tr>}>
              {(item) => <MarketRow item={item} />}
            </For>
          </tbody>
        </table>
      </div>
    </>
  );
};

export default App;