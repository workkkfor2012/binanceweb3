// packages/frontend/src/CompactRankingListsContainer.tsx
import { Component, createMemo, For, JSX, Show } from 'solid-js';
import type { MarketItem } from 'shared-types';
import type { ChartTheme } from './themes';

const BACKEND_URL = 'https://localhost:3001';

const formatPercentage = (change: string | number | null | undefined): JSX.Element => {
    if (change === null || change === undefined) return <span class="na">N/A</span>;
    const value = typeof change === 'string' ? parseFloat(change) : change;
    const changeClass = value >= 0 ? 'positive' : 'negative';
    return <span class={changeClass}>{value.toFixed(2)}%</span>;
};

interface CompactListProps {
    title: string;
    data: MarketItem[];
    rankBy: keyof MarketItem;
    formatter: (value: any) => string | JSX.Element;
    onHeaderClick: (rankBy: keyof MarketItem) => void;
    blockList: Set<string>;
    onItemClick?: (item: MarketItem) => void;
    theme: ChartTheme;
}

const CompactRankingList: Component<CompactListProps> = (props) => {
    const rankedData = createMemo(() => {
        const blocked = props.blockList;
        const validData = props.data.filter(item => {
            // ✅ 规则 1: 过滤黑名单
            if (blocked.has(item.contractAddress)) return false;

            const value = item[props.rankBy];

            // ✅ 规则 2: 去掉无图标的强制检查，只要数值有效即可
            return value !== null && value !== undefined && String(value).trim() !== '';
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
            <h3
                onClick={() => props.onHeaderClick(props.rankBy)}
                class="clickable-header"
                style={{
                    "color": props.theme.layout.textColor,
                    "border-bottom-color": props.theme.grid.horzLines
                }}
            >
                {props.title}
            </h3>
            <ul>
                <For each={rankedData()} fallback={<li style={{ color: props.theme.layout.textColor }}>-</li>}>
                    {(item) => (
                        <li
                            title={`${item.chain}: ${item.contractAddress}`}
                            onClick={() => props.onItemClick?.(item)}
                            class={props.onItemClick ? 'item-clickable' : ''}
                            style={{
                                "border-bottom-color": props.theme.grid.horzLines,
                                "color": props.theme.layout.textColor
                            }}
                        >
                            <div class="symbol-and-icon">
                                {/* 图标显示逻辑：有图显示，无图显示占位符 */}
                                <Show
                                    when={item.icon}
                                    fallback={
                                        <div class="icon" style={{
                                            background: props.theme.grid.vertLines,
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '10px',
                                            color: props.theme.layout.textColor
                                        }}>?</div>
                                    }
                                >
                                    <img
                                        src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon!)}&symbol=${item.symbol}`}
                                        alt={item.symbol}
                                        class="icon"
                                        onError={(e) => {
                                            // console.error(`[IconError] Symbol: ${item.symbol} | URL: ${e.currentTarget.src}`);
                                            e.currentTarget.style.display = 'none';
                                        }}
                                    />
                                </Show>
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

interface RawDataListProps {
    data: MarketItem[];
    blockList: Set<string>;
    onItemClick?: (item: MarketItem) => void;
    theme: ChartTheme;
}

const RawDataList: Component<RawDataListProps> = (props) => {
    const displayData = createMemo(() => {
        // ✅ 规则: 仅过滤黑名单，不做切片，按 1h 涨幅排序
        const blocked = props.blockList;
        const filtered = props.data.filter(item => !blocked.has(item.contractAddress));

        return filtered.sort((a, b) => {
            const valA = a.priceChange1h ?? -Infinity;
            const valB = b.priceChange1h ?? -Infinity;
            const numA = typeof valA === 'string' ? parseFloat(valA) : valA;
            const numB = typeof valB === 'string' ? parseFloat(valB) : valB;
            return numB - numA;
        });
    });

    return (
        <div class="compact-ranking-list">
            <h3 style={{
                color: props.theme.layout.textColor,
                "border-bottom-color": props.theme.grid.horzLines
            }}>
                全量监控 (按1h排序)
            </h3>
            <div style={{ "height": "calc(100vh - 150px)", "overflow-y": "auto", "padding-right": "5px" }}>
                <ul>
                    <For each={displayData()}>
                        {(item) => (
                            <li
                                onClick={() => props.onItemClick?.(item)}
                                class={props.onItemClick ? 'item-clickable' : ''}
                                style={{
                                    "border-bottom-color": props.theme.grid.horzLines,
                                    "color": props.theme.layout.textColor
                                }}
                            >
                                <div class="symbol-and-icon">
                                    <Show
                                        when={item.icon}
                                        fallback={
                                            <div class="icon" style={{
                                                background: props.theme.grid.vertLines,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                fontSize: '10px',
                                                color: props.theme.layout.textColor
                                            }}>?</div>
                                        }
                                    >
                                        <img
                                            src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon!)}&symbol=${item.symbol}`}
                                            alt={item.symbol}
                                            class="icon"
                                            onError={(e) => {
                                                // console.error(`[IconError] Symbol: ${item.symbol} | URL: ${e.currentTarget.src}`);
                                                e.currentTarget.style.display = 'none';
                                            }}
                                        />
                                    </Show>
                                    <span class="symbol-compact">{item.symbol}</span>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                                    <span class="value-compact" style={{ "font-size": "0.85em" }}>
                                        {formatPercentage(item.priceChange1h)}
                                    </span>
                                </div>
                            </li>
                        )}
                    </For>
                </ul>
            </div>
        </div>
    );
}

interface ContainerProps {
    marketData: MarketItem[];
    lastUpdate: string;
    onHeaderClick: (rankBy: keyof MarketItem) => void;
    blockList: Set<string>;
    onItemClick?: (item: MarketItem) => void;
    theme: ChartTheme;
}

const CompactRankingListsContainer: Component<ContainerProps> = (props) => {
    // ✨ 恢复完整的榜单列表，包括 1h 和 24h
    const PRICE_CHANGE_RANKINGS = [
        { field: 'priceChange1m', title: '1m 涨幅' },
        { field: 'priceChange5m', title: '5m 涨幅' },
        { field: 'priceChange1h', title: '1h 涨幅' }, // ✨ 已恢复
        { field: 'priceChange4h', title: '4h 涨幅' },
        { field: 'priceChange24h', title: '24h 涨幅' }, // ✨ 已恢复
    ];

    return (
        <div class="compact-ranking-list-container">
            <div
                class="update-timestamp"
                style={{ "border-bottom-color": props.theme.grid.horzLines }}
            >
                <span style={{ "color": props.theme.layout.textColor, opacity: 0.7 }}>Last Update:</span>
                <strong>{props.lastUpdate}</strong>
            </div>

            <div class="ranking-columns">
                {/* 左侧: 精选榜单 (Top 9, 过滤黑名单，不强制图标) */}
                <div class="ranking-section" style={{ flex: '0 0 45%' }}>
                    <h2 style={{
                        "color": props.theme.layout.textColor,
                        "border-bottom-color": props.theme.grid.horzLines
                    }}>
                        精选榜单
                    </h2>
                    <For each={PRICE_CHANGE_RANKINGS}>
                        {(ranking) => (
                            <CompactRankingList
                                title={ranking.title}
                                data={props.marketData}
                                rankBy={ranking.field as keyof MarketItem}
                                formatter={formatPercentage}
                                onHeaderClick={props.onHeaderClick}
                                blockList={props.blockList}
                                onItemClick={props.onItemClick}
                                theme={props.theme}
                            />
                        )}
                    </For>
                </div>

                {/* 右侧: 全量列表 (按 1h 排序，过滤黑名单，显示所有) */}
                <div class="ranking-section" style={{ flex: '1' }}>
                    <RawDataList
                        data={props.marketData}
                        blockList={props.blockList}
                        onItemClick={props.onItemClick}
                        theme={props.theme}
                    />
                </div>
            </div>
        </div>
    );
};

export default CompactRankingListsContainer;