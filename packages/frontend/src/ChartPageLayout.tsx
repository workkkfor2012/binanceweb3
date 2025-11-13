// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import MultiChartGrid from './MultiChartGrid';
import { initializeVoices, checkAndTriggerAlerts } from './AlertManager';

// ✨ 核心修改 1: 定义新的同步状态类型
export interface ViewportState {
    width: number; // 逻辑宽度，代表缩放
    offset: number; // 相对于最后一根bar的右侧偏移量，代表平移
}

const BACKEND_URL = 'http://localhost:3001';
const BLOCKLIST_STORAGE_KEY = 'trading-dashboard-blocklist';

const TIMEFRAME_MAP: Record<string, string> = {
    '1': '1m', '2': '5m', '3': '1h', '4': '4h', '5': '1d',
};
export const ALL_TIMEFRAMES = Object.values(TIMEFRAME_MAP);

const loadBlockListFromStorage = (): Set<string> => {
    try {
        const storedList = localStorage.getItem(BLOCKLIST_STORAGE_KEY);
        if (storedList) {
            const parsedArray = JSON.parse(storedList);
            if (Array.isArray(parsedArray)) return new Set(parsedArray);
        }
    } catch (error) { console.error('[Blocklist] Failed to load blocklist:', error); }
    return new Set();
};

const saveBlockListToStorage = (blockList: Set<string>): void => {
    try {
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(Array.from(blockList)));
    } catch (error) { console.error('[Blocklist] Failed to save blocklist:', error); }
};

const ChartPageLayout: Component = () => {
    const [marketData, setMarketData] = createStore<MarketItem[]>([]);
    const [lastUpdate, setLastUpdate] = createSignal('Connecting...');
    const [activeRankBy, setActiveRankBy] = createSignal<keyof MarketItem | null>('volume1m');
    const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());
    const [activeTimeframe, setActiveTimeframe] = createSignal(ALL_TIMEFRAMES[0]);

    // ✨ 核心修改 2: 更改状态为 ViewportState
    const [viewportState, setViewportState] = createSignal<ViewportState | null>(null);
    const [activeChartId, setActiveChartId] = createSignal<string | null>(null);

    const handleViewportChange = (newState: ViewportState | null) => {
        setViewportState(newState);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
            const newTimeframe = TIMEFRAME_MAP[e.key];
            console.log(`[Layout] Hotkey '${e.key}' pressed. Changing timeframe to ${newTimeframe}`);
            setActiveTimeframe(newTimeframe);
            setViewportState(null); // 切换时间周期时重置视图
        }
    };

    const handleNewAlert = (logMessage: string, alertType: 'volume' | 'price') => {
        console.log(`[ChartPage Alert] [${alertType.toUpperCase()}] ${logMessage}`);
    };

    onMount(() => {
        // ... (socket connection and other logic remains the same)
        const socket: Socket = io(BACKEND_URL);
        socket.on('connect', () => setLastUpdate('Connected, waiting for data...'));
        socket.on('disconnect', () => setLastUpdate('Disconnected'));
        socket.on('data-broadcast', (payload: DataPayload) => {
            if (!payload.data || payload.data.length === 0) return;
            const blocked = blockList();
            for (const newItem of payload.data) {
                if (!blocked.has(newItem.contractAddress)) {
                    const oldItem = marketData.find(d => 
                        d.contractAddress === newItem.contractAddress && d.chain === newItem.chain
                    );
                    if (oldItem) {
                        checkAndTriggerAlerts(newItem, oldItem, handleNewAlert);
                    }
                }
            }
            setMarketData(produce(currentData => {
                for (const item of payload.data) {
                    const index = currentData.findIndex(d => d.contractAddress === item.contractAddress && d.chain === item.chain);
                    if (index > -1) Object.assign(currentData[index], item);
                    else currentData.push(item);
                }
            }));
            setLastUpdate(new Date().toLocaleTimeString());
        });
        initializeVoices();
        window.addEventListener('keydown', handleKeyDown);
        onCleanup(() => {
            socket.disconnect();
            window.removeEventListener('keydown', handleKeyDown);
        });
    });

    const handleBlockToken = (contractAddress: string) => {
        const newBlockList = new Set(blockList());
        newBlockList.add(contractAddress);
        setBlockList(newBlockList);
        console.log(`[Blocklist] Token ${contractAddress} added.`);
    };

    const rankedTokensForGrid = createMemo(() => {
        // ... (this logic remains the same)
        const rankBy = activeRankBy();
        const blocked = blockList(); 
        if (!rankBy) return [];
        return [...marketData]
            .filter(item => !blocked.has(item.contractAddress))
            .filter(item => item.icon && item[rankBy] != null)
            .sort((a, b) => {
                const valA = a[rankBy]!;
                const valB = b[rankBy]!;
                return (typeof valB === 'string' ? parseFloat(valB) : valB) - 
                       (typeof valA === 'string' ? parseFloat(valA) : valA);
            })
            .slice(0, 9);
    });

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
                    blockList={blockList()}
                />
            </div>
            <div class="right-chart-grid">
                <div class="grid-header">
                    <div class="active-timeframe-indicator">
                        <span>Timeframe: </span>
                        <strong>{activeTimeframe().toUpperCase()}</strong>
                        <span class="hotkey-hint">(Keys: 1-5)</span>
                    </div>
                </div>
                {/* ✨ 核心修改 3: 传递新的 props */}
                <MultiChartGrid 
                    tokens={rankedTokensForGrid()} 
                    onBlockToken={handleBlockToken} 
                    timeframe={activeTimeframe()}
                    viewportState={viewportState()}
                    onViewportChange={handleViewportChange}
                    activeChartId={activeChartId()}
                    onSetActiveChart={setActiveChartId}
                />
            </div>
        </div>
    );
};

export default ChartPageLayout;