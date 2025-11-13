// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import MultiChartGrid from './MultiChartGrid';

const BACKEND_URL = 'http://localhost:3001';

const ChartPageLayout: Component = () => {
    const [marketData, setMarketData] = createStore<MarketItem[]>([]);
    const [lastUpdate, setLastUpdate] = createSignal('Connecting...');
    
    // ✨ 核心修正 2.1: 创建一个 signal 来存储当前激活的排名类型
    const [activeRankBy, setActiveRankBy] = createSignal<keyof MarketItem | null>(null);

    onMount(() => {
        const socket: Socket = io(BACKEND_URL);
        socket.on('connect', () => setLastUpdate('Connected, waiting for data...'));
        socket.on('disconnect', () => setLastUpdate('Disconnected'));

        socket.on('data-broadcast', (payload: DataPayload) => {
            const { data } = payload;
            if (!data || data.length === 0) return;

            setMarketData(produce(currentData => {
                for (const item of data) {
                    const index = currentData.findIndex(d => 
                        d.contractAddress === item.contractAddress && d.chain === item.chain
                    );
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
    
    // ✨ 核心修正 2.2: createMemo 会在 marketData 或 activeRankBy 变化时自动重新计算
    const rankedTokensForGrid = createMemo(() => {
        const rankBy = activeRankBy();
        // 如果没有选择任何排名，返回空数组
        if (!rankBy) {
            return [];
        }
        
        // 当 marketData 更新时，这里的代码会自动执行
        console.log(`[Re-ranking] Market data or rank key changed. Recalculating for "${rankBy}".`);

        return [...marketData]
            .filter(item => {
                const value = item[rankBy];
                return item.icon && value !== null && value !== undefined && String(value).trim() !== '';
            })
            .sort((a, b) => {
                const valA = a[rankBy]!;
                const valB = b[rankBy]!;
                const numA = typeof valA === 'string' ? parseFloat(valA) : valA;
                const numB = typeof valB === 'string' ? parseFloat(valB) : valB;
                return numB - numA;
            })
            .slice(0, 9);
    });

    // ✨ 核心修正 2.3: 点击处理器现在只负责设置激活的排名类型
    const handleRankingHeaderClick = (rankBy: keyof MarketItem) => {
        console.log(`[Layout] User selected new ranking: ${rankBy}.`);
        setActiveRankBy(rankBy);
    };


    return (
        <div class="chart-page-container">
            <div class="left-sidebar">
                <CompactRankingListsContainer 
                    marketData={marketData}
                    lastUpdate={lastUpdate()} 
                    onHeaderClick={handleRankingHeaderClick}
                />
            </div>
            <div class="right-chart-grid">
                {/* 将 memoized 的结果传递给图表网格 */}
                <MultiChartGrid tokens={rankedTokensForGrid()} />
            </div>
        </div>
    );
};

export default ChartPageLayout;