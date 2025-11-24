// packages/frontend/src/App.tsx
import { createSignal, onMount, For, Component, JSX, createMemo } from 'solid-js';
import type { MarketItem } from 'shared-types';
import { useMarketData } from './hooks/useMarketData'; // ✨ 引入核心 Hook

const BACKEND_URL = 'http://localhost:3001';
const CHAINS = ['BSC', 'Base', 'Solana'];

// --- 辅助函数区 ---
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
  if (num > 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num > 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};

// --- 排行榜组件 ---
interface RankingListProps {
  data: MarketItem[];
  rankBy: keyof MarketItem;
  title: string;
  count: number;
  formatter: (value: any) => string | JSX.Element;
}

const RankingList: Component<RankingListProps> = (props) => {
  const rankedData = createMemo(() => {
    // 简单的排序逻辑，这里不需要过滤黑名单，因为 App 页通常显示全貌
    // 如果需要过滤，可以传入 blockList
    const sorted = [...props.data].sort((a, b) => {
      const valA = a[props.rankBy] ?? -Infinity;
      const valB = b[props.rankBy] ?? -Infinity;
      const numA = typeof valA === 'string' ? parseFloat(valA) : valA;
      const numB = typeof valB === 'string' ? parseFloat(valB) : valB;
      return numB - numA;
    });
    return sorted.slice(0, props.count);
  });

  return (
    <div class="ranking-list">
      <h3>{props.title}</h3>
      <ol>
        <For each={rankedData()} fallback={<li>-</li>}>
          {(item) => (
            <li>
              <span class="symbol" title={item.symbol}>{item.symbol}</span>
              <span class="value">{props.formatter(item[props.rankBy])}</span>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
};

// --- MarketRow 组件 ---
interface MarketRowProps {
  item: MarketItem;
}
const MarketRow: Component<MarketRowProps> = (props) => {
  const { item } = props;
  const proxiedIconUrl = () => `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon!)}`;
  
  // 点击跳转到详情页
  const handleRowClick = () => {
      window.open(`/token.html?address=${item.contractAddress}&chain=${item.chain}`, '_blank');
  };

  return (
    <tr onClick={handleRowClick} style={{ cursor: 'pointer' }}>
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

// --- 排行榜配置 ---
const RANKING_COUNT = 9;
const VOLUME_RANKINGS = [
  { field: 'volume1m', title: '1m 成交额' },
  { field: 'volume5m', title: '5m 成交额' },
  { field: 'volume1h', title: '1h 成交额' },
  { field: 'volume4h', title: '4h 成交额' },
  { field: 'volume24h', title: '24h 成交额' },
];
const PRICE_CHANGE_RANKINGS = [
  { field: 'priceChange1m', title: '1m 涨幅' },
  { field: 'priceChange5m', title: '5m 涨幅' },
  { field: 'priceChange1h', title: '1h 涨幅' },
  { field: 'priceChange4h', title: '4h 涨幅' },
  { field: 'priceChange24h', title: '24h 涨幅' },
];

const App: Component = () => {
  // ✨ 核心: 使用统一的 Hook 获取数据和状态
  const { marketData, connectionStatus, lastUpdate } = useMarketData();
  
  const [desiredFields, setDesiredFields] = createSignal<string[]>([]);
  const [selectedChain, setSelectedChain] = createSignal<string>(CHAINS[0]);
  
  // 根据当前选择的链过滤表格数据
  const filteredData = createMemo(() => 
    marketData.filter(item => item.chain === selectedChain())
  );
  
  onMount(() => {
    console.log('[App] 🚀 Mounting Main Dashboard (Table View)...');

    // 获取表格列配置 (App 独有逻辑)
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
        // 简单的去重与排序
        const orderedFields = [...new Set([...preferredOrder, ...fields])];
        const finalFields = orderedFields.filter(f => fields.includes(f));
        setDesiredFields(finalFields);
        console.log(`[App] Loaded ${finalFields.length} table columns.`);
      } catch (error) {
        console.error("[App] ❌ Failed to fetch desired fields:", error);
      }
    };
    fetchDesiredFields();
  });

  return (
    <>
      <h1>实时市场数据监控 (Table View)</h1>
      <div class="stats-and-logs">
        <div class="stats">
          <p>
            状态: 
            <span class={connectionStatus().includes('Connected') ? 'connected' : 'disconnected'}>
               {connectionStatus()}
            </span>
          </p>
          <p>最后更新: <span>{lastUpdate()}</span></p>
          <p>总品种数: <span>{marketData.length}</span></p>
          <p>当前链品种: <span>{filteredData().length}</span></p>
        </div>
      </div>

      {/* --- 成交额排行榜 --- */}
      <div class="rankings-container">
        <h2>成交额排名</h2>
        <div class="rankings-grid">
          <For each={VOLUME_RANKINGS}>
            {(ranking) => (
              <RankingList
                data={marketData}
                rankBy={ranking.field as keyof MarketItem}
                title={ranking.title}
                count={RANKING_COUNT}
                formatter={(v) => formatVolumeOrMarketCap(v as number)}
              />
            )}
          </For>
        </div>
      </div>

      {/* --- 涨幅排行榜 --- */}
      <div class="rankings-container">
        <h2>价格涨幅排名</h2>
        <div class="rankings-grid">
          <For each={PRICE_CHANGE_RANKINGS}>
            {(ranking) => (
              <RankingList
                data={marketData}
                rankBy={ranking.field as keyof MarketItem}
                title={ranking.title}
                count={RANKING_COUNT}
                formatter={(v) => formatPercentage(v as string)}
              />
            )}
          </For>
        </div>
      </div>

      {/* --- 链选择器 --- */}
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

      {/* --- 详细数据表格 --- */}
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
            <For 
                each={filteredData()} 
                fallback={<tr><td colspan={desiredFields().length || 1} style="text-align:center; padding: 20px;">等待数据或该链无数据...</td></tr>}
            >
              {(item) => <MarketRow item={item} />}
            </For>
          </tbody>
        </table>
      </div>
    </>
  );
};

export default App;