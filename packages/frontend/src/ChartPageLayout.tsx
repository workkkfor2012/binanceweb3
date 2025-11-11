// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import MultiChartGrid from './MultiChartGrid';

const BACKEND_URL = 'http://localhost:3001';

const ChartPageLayout: Component = () => {
    // 状态：用于存储从后端接收的所有市场数据
    const [marketData, setMarketData] = createStore<MarketItem[]>([]);
    // 状态：用于显示最后更新时间
    const [lastUpdate, setLastUpdate] = createSignal('Connecting...');

    // onMount 中建立 WebSocket 连接
    onMount(() => {
        const socket: Socket = io(BACKEND_URL);

        socket.on('connect', () => setLastUpdate('Connected, waiting for data...'));
        socket.on('disconnect', () => setLastUpdate('Disconnected'));

        socket.on('data-broadcast', (payload: DataPayload) => {
            const { data } = payload;
            if (!data || data.length === 0) return;

            setMarketData(produce(currentData => {
                for (const item of data) {
                    // 我们接收所有链的数据，所以用合约地址+链作为唯一键
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

            // 更新时间戳
            setLastUpdate(new Date().toLocaleTimeString());
        });

        // onCleanup 中断开连接，防止内存泄漏
        onCleanup(() => socket.disconnect());
    });

    return (
        <div class="chart-page-container">
            <div class="left-sidebar">
                {/* 将实时数据和更新时间传递给左侧排名容器 */}
                <CompactRankingListsContainer 
                    marketData={marketData}
                    lastUpdate={lastUpdate()} 
                />
            </div>
            <div class="right-chart-grid">
                <MultiChartGrid />
            </div>
        </div>
    );
};

export default ChartPageLayout;