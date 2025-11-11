// packages/frontend/src/CompactRankingListsContainer.tsx
import { Component, createMemo, For, JSX } from 'solid-js';
import type { MarketItem } from 'shared-types';

// 🌟 1. 从 App.tsx 复制 BACKEND_URL 常量
const BACKEND_URL = 'http://localhost:3001';

// --- 辅助函数 & 组件 (这部分无变化) ---
const formatPercentage = (change: string | number | null | undefined): JSX.Element => {
    if (change === null || change === undefined) return <span class="na">N/A</span>;
    const value = typeof change === 'string' ? parseFloat(change) : change;
    const changeClass = value >= 0 ? 'positive' : 'negative';
    return <span class={changeClass}>{value.toFixed(2)}</span>;
};

const formatVolume = (num: number | null | undefined): string => {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toFixed(0);
};

interface CompactListProps {
  title: string;
  data: MarketItem[];
  rankBy: keyof MarketItem;
  formatter: (value: any) => string | JSX.Element;
}

const CompactRankingList: Component<CompactListProps> = (props) => {
    const rankedData = createMemo(() => {
        const validData = props.data.filter(item => {
            const value = item[props.rankBy];
            return item.icon && value !== null && value !== undefined && String(value).trim() !== '';
        });

        return validData
            .sort((a, b) => {
                const valA = a[props.rankBy]!;
                const valB = b[props.rankBy]!;
                const numA = typeof valA === 'string' ? parseFloat(valA) : valA;
                const numB = typeof valB === 'string' ? parseFloat(valB) : valB;
                return numB - numA;
            })
            .slice(0, 9);
    });

    return (
        <div class="compact-ranking-list">
            <h3>{props.title}</h3>
            <ul>
                <For each={rankedData()} fallback={<li>-</li>}>
                    {(item) => (
                        <li title={`${item.chain}: ${item.contractAddress}`}>
                            {/* 🌟 2. 添加图标和容器 */}
                            <div class="symbol-and-icon">
                                <img 
                                    src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon!)}`} 
                                    alt={item.symbol} 
                                    class="icon" 
                                />
                                <span class="symbol-compact">{item.symbol}</span>
                            </div>
                            <span class="value-compact">{props.formatter(item[props.rankBy])}</span>
                        </li>
                    )}
                </For>
            </ul>
        </div>
    );
};

// --- 主容器组件 (无变化) ---
interface ContainerProps {
    marketData: MarketItem[];
    lastUpdate: string;
}

const CompactRankingListsContainer: Component<ContainerProps> = (props) => {
    const PRICE_CHANGE_RANKINGS = [
      { field: 'priceChange1m', title: '1m 涨幅' },
      { field: 'priceChange5m', title: '5m 涨幅' },
      { field: 'priceChange1h', title: '1h 漲幅' },
      { field: 'priceChange4h', title: '4h 漲幅' },
      { field: 'priceChange24h', title: '24h 漲幅' },
    ];
    const VOLUME_RANKINGS = [
      { field: 'volume1m', title: '1m 成交额' },
      { field: 'volume5m', title: '5m 成交额' },
      { field: 'volume1h', title: '1h 成交额' },
      { field: 'volume4h', title: '4h 成交额' },
      { field: 'volume24h', title: '24h 成交额' },
    ];

    return (
        <div class="compact-ranking-list-container">
            <div class="update-timestamp">
                <span>Last Update:</span>
                <strong>{props.lastUpdate}</strong>
            </div>
            
            <div class="ranking-columns">
                <div class="ranking-section">
                    <h2>价格涨幅排名</h2>
                    <For each={PRICE_CHANGE_RANKINGS}>
                        {(ranking) => (
                            <CompactRankingList
                                title={ranking.title}
                                data={props.marketData}
                                rankBy={ranking.field as keyof MarketItem}
                                formatter={formatPercentage}
                            />
                        )}
                    </For>
                </div>
                
                <div class="ranking-section">
                    <h2>成交额排名</h2>
                    <For each={VOLUME_RANKINGS}>
                        {(ranking) => (
                            <CompactRankingList
                                title={ranking.title}
                                data={props.marketData}
                                rankBy={ranking.field as keyof MarketItem}
                                formatter={formatVolume}
                            />
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
};

export default CompactRankingListsContainer;