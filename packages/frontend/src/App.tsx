// packages/frontend/src/App.tsx
import { createSignal, onMount, onCleanup, For, Component, JSX, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
import type { MarketItem, DataPayload } from 'shared-types';
import { initializeVoices, checkAndTriggerAlerts } from './AlertManager';

const BACKEND_URL = 'http://localhost:3001';
const CHAINS = ['BSC', 'Base', 'Solana'];
const MAX_LOG_ENTRIES = 50;

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

interface LogEntry {
  timestamp: string;
  message: string;
}

const App: Component = () => {
  const [status, setStatus] = createSignal<'connecting...' | 'connected' | 'disconnected'>('connecting...');
  const [lastUpdate, setLastUpdate] = createSignal('N/A');
  const [marketData, setMarketData] = createStore<MarketItem[]>([]);
  const [desiredFields, setDesiredFields] = createSignal<string[]>([]);
  const [selectedChain, setSelectedChain] = createSignal<string>(CHAINS[0]);
  
  const [volumeLogs, setVolumeLogs] = createSignal<LogEntry[]>([]);
  const [priceLogs, setPriceLogs] = createSignal<LogEntry[]>([]);

  const filteredData = createMemo(() => 
    marketData.filter(item => item.chain === selectedChain())
  );
  
  const handleNewAlert = (logMessage: string, alertType: 'volume' | 'price') => {
    // ✨ --- 日志修改: 增加UI更新日志 --- ✨
    console.log(`[UIFlow] handleNewAlert: 即将更新 "${alertType}" 类型的UI日志, 内容: "${logMessage}"`);
    // --- 日志修改结束 ---

    const newLog: LogEntry = {
      timestamp: new Date().toLocaleTimeString(),
      message: logMessage,
    };
    if (alertType === 'volume') {
      setVolumeLogs(prev => [newLog, ...prev].slice(0, MAX_LOG_ENTRIES));
    } else {
      setPriceLogs(prev => [newLog, ...prev].slice(0, MAX_LOG_ENTRIES));
    }
  };


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
        const orderedFields = [...new Set([...preferredOrder, ...fields])];
        const finalFields = orderedFields.filter(f => fields.includes(f));
        setDesiredFields(finalFields);
      } catch (error) {
        console.error("无法获取监控字段列表:", error);
      }
    };
    fetchDesiredFields();

    const socket: Socket = io(BACKEND_URL);
    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));

    socket.on('data-broadcast', (payload: DataPayload) => {
      const { type, data } = payload;
      if (!data || data.length === 0) return;

      // ✨ --- 核心修正 --- ✨
      // 步骤 1: 先执行副作用（检查提醒）
      for (const newItem of data) {
        const oldItem = marketData.find(d => d.contractAddress === newItem.contractAddress && d.chain === newItem.chain);
        if (oldItem) {
          checkAndTriggerAlerts(newItem, oldItem, handleNewAlert);
        }
      }

      // 步骤 2: 再更新状态
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
      // ✨ --- 修正结束 --- ✨

      setLastUpdate(new Date().toLocaleTimeString());
    });

    initializeVoices();

    onCleanup(() => socket.disconnect());
  });

  return (
    <>
      <h1>实时市场数据监控</h1>
      <div class="stats-and-logs">
        <div class="stats">
          <p>状态: <span class={status()}>{status()}</span></p>
          <p>最后更新: <span>{lastUpdate()}</span></p>
          <p>当前链品种: <span>{filteredData().length}</span></p>
        </div>
        
        <div class="alert-logs">
          <h2>成交金额提醒</h2>
          <ul>
            <For each={volumeLogs()} fallback={<li>暂无提醒</li>}>
              {(log) => (
                <li>
                  <span class="timestamp">[{log.timestamp}]</span>
                  <span class="message">{log.message}</span>
                </li>
              )}
            </For>
          </ul>
        </div>

        <div class="alert-logs">
          <h2>价格幅度提醒</h2>
          <ul>
            <For each={priceLogs()} fallback={<li>暂无提醒</li>}>
              {(log) => (
                <li>
                  <span class="timestamp">[{log.timestamp}]</span>
                  <span class="message">{log.message}</span>
                </li>
              )}
            </For>
          </ul>
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