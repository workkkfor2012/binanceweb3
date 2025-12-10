// packages/frontend/src/App.tsx
import { createSignal, onMount, For, Component, JSX, createMemo } from 'solid-js';
import type { MarketItem, HotlistItem } from './types'; // 引入修正后的类型
import { useMarketData } from './hooks/useMarketData';

const BACKEND_URL = 'https://localhost:3001';
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
  // ✨ 这些字段现在对应 HotlistItem 中的 Optional Fields
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
    // ✨ 排序逻辑增强：处理可选字段 undefined 的情况
    const sorted = [...props.data].sort((a, b) => {
      // 使用类型断言访问可能的动态属性
      const valA = (a as any)[props.rankBy] ?? -Infinity;
      const valB = (b as any)[props.rankBy] ?? -Infinity;

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
              {/* @ts-ignore: Dynamic access is safe here due to createMemo logic */}
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
  const proxiedIconUrl = () => item.icon ? `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon)}` : '';

  const handleRowClick = () => {
    window.open(`/token.html?address=${item.contractAddress}&chain=${item.chain}`, '_blank');
  };

  // 辅助函数：安全获取 HotlistItem 独有的可选字段
  // 因为 MemeItem 没有这些字段，直接访问会报错
  const getHotlistField = (field: keyof HotlistItem) => {
    if (item.source === 'hotlist') {
      return (item as HotlistItem)[field];
    }
    return undefined;
  }

  return (
    <tr onClick={handleRowClick} style={{ cursor: 'pointer' }}>
      <td><img src={proxiedIconUrl()} alt={item.symbol} class="icon" onError={(e) => e.currentTarget.style.display = 'none'} /></td>
      <td>{item.symbol}</td>
      <td>{item.chain}</td>
      <td>{formatPrice(item.price)}</td>
      <td>{formatPercentage(item.priceChange24h)}</td>
      <td>{formatVolumeOrMarketCap(item.volume24h)}</td>
      <td>{formatVolumeOrMarketCap(item.marketCap)}</td>
      {/* 某些字段可能不存在于 MemeItem，使用 optional access 或 helper */}
      <td>{(item as any).chainId || '-'}</td>
      <td title={item.contractAddress}>{`${String(item.contractAddress).substring(0, 6)}...`}</td>

      {/* ✨ 即使是可选字段，现在也能通过类型检查，不会报错 */}
      <td>{formatPercentage(getHotlistField('priceChange1m'))}</td>
      <td>{formatPercentage(getHotlistField('priceChange5m'))}</td>
      <td>{formatPercentage(getHotlistField('priceChange1h'))}</td>
      <td>{formatPercentage(getHotlistField('priceChange4h'))}</td>
      <td>{formatVolumeOrMarketCap(getHotlistField('volume1m'))}</td>
      <td>{formatVolumeOrMarketCap(getHotlistField('volume5m'))}</td>
      <td>{formatVolumeOrMarketCap(getHotlistField('volume1h'))}</td>
      <td>{formatVolumeOrMarketCap(getHotlistField('volume4h'))}</td>
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
  const { marketData, connectionStatus, lastUpdate } = useMarketData('hotlist');

  const [desiredFields, setDesiredFields] = createSignal<string[]>([]);
  const [selectedChain, setSelectedChain] = createSignal<string>(CHAINS[0]);

  const filteredData = createMemo(() =>
    marketData.filter(item => item.chain === selectedChain())
  );

  onMount(() => {
    console.log('[App] 🚀 Mounting Main Dashboard (Table View)...');
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
    <div class="page-wrapper">
      <header class="app-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div class="header-left">
          <h1>🔥 Market Hotlist</h1>
          <nav class="nav-links" style={{ display: 'flex', gap: '15px', marginTop: '10px' }}>
            <span class="nav-btn active" style={{ fontWeight: 'bold', textDecoration: 'underline' }}>🔥 Hotlist</span>
            <a href="/meme.html" class="nav-btn" style={{ textDecoration: 'none', color: '#666' }}>🐶 Meme New</a>
          </nav>
        </div>

        <div class="stats-panel">
          <div class="status-indicator">
            <span>Status: </span>
            <span class={connectionStatus().includes('Connected') ? 'positive' : 'negative'}>
              {connectionStatus()}
            </span>
          </div>
          <div class="update-time">Upd: {lastUpdate()}</div>
          <div class="count-badge">Count: {filteredData().length} / {marketData.length}</div>
        </div>
      </header>

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
            <For
              each={filteredData()}
              fallback={<tr><td colspan={desiredFields().length || 1} style="text-align:center; padding: 20px;">等待数据或该链无数据...</td></tr>}
            >
              {(item) => <MarketRow item={item} />}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default App;