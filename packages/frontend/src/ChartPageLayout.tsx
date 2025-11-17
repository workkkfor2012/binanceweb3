// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup, createMemo, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from './socket'; // ✨ 使用共享的 socket 实例
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import MultiChartGrid from './MultiChartGrid';
import SingleTokenView from './SingleTokenView';
import { initializeVoices, checkAndTriggerAlerts } from './AlertManager';

export interface ViewportState {
    width: number;
    offset: number;
}

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
    const [viewportState, setViewportState] = createSignal<ViewportState | null>(null);
    const [activeChartId, setActiveChartId] = createSignal<string | null>(null);

    const [viewMode, setViewMode] = createSignal<'grid' | 'single'>('grid');
    const [focusedToken, setFocusedToken] = createSignal<MarketItem | null>(null);

    const handleViewportChange = (newState: ViewportState | null) => {
        setViewportState(newState);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

        if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
            const newTimeframe = TIMEFRAME_MAP[e.key];
            console.log(`[Layout] Hotkey '${e.key}' pressed. Changing timeframe to ${newTimeframe}`);
            setActiveTimeframe(newTimeframe);
            if (viewMode() === 'grid') {
                setViewportState(null);
            }
            return;
        }

        if (e.key.toLowerCase() === 'f') {
            if (viewMode() === 'grid') {
                const hoveredTokenId = activeChartId();
                if (hoveredTokenId) {
                    const token = rankedTokensForGrid().find(t => t.contractAddress === hoveredTokenId);
                    if (token) {
                        console.log(`[Layout] Entering single view for ${token.symbol}`);
                        setFocusedToken(token);
                        setViewMode('single');
                    }
                }
            } else {
                console.log('[Layout] Exiting single view.');
                setViewMode('grid');
                setFocusedToken(null);
            }
        }
    };

    const handleNewAlert = (logMessage: string, alertType: 'volume' | 'price') => {
        console.log(`[ChartPage Alert] [${alertType.toUpperCase()}] ${logMessage}`);
    };

    onMount(() => {
        // 确保 socket 连接，如果它断开了，它会自动重连
        if (!socket.connected) {
            socket.connect();
        }
        
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
            // 在组件卸载时，只移除此组件关心的事件监听器，而不是断开整个 socket
            socket.off('connect');
            socket.off('disconnect');
            socket.off('data-broadcast');
            window.removeEventListener('keydown', handleKeyDown);
        });
    });

    const handleBlockToken = (contractAddress: string) => {
        const newBlockList = new Set(blockList());
        newBlockList.add(contractAddress);
        setBlockList(newBlockList);
        saveBlockListToStorage(newBlockList);
        console.log(`[Blocklist] Token ${contractAddress} added.`);
    };

    const rankedTokensForGrid = createMemo(() => {
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

    // ✨ 核心修改: 定义点击跳转逻辑
    const handleRankingItemClick = (item: MarketItem) => {
        const url = `/token.html?address=${item.contractAddress}&chain=${item.chain}`;
        // 在新标签页中打开
        window.open(url, '_blank');
    };

    return (
        <div class="chart-page-container">
            <div class="left-sidebar">
                <CompactRankingListsContainer 
                    marketData={marketData}
                    lastUpdate={lastUpdate()} 
                    onHeaderClick={handleRankingHeaderClick}
                    blockList={blockList()}
                    onItemClick={handleRankingItemClick} // ✨ 传递处理器
                />
            </div>
            <div class="right-chart-grid">
                <Show
                    when={viewMode() === 'single' && focusedToken()}
                    fallback={
                        <>
                            <div class="grid-header">
                                <div class="active-timeframe-indicator">
                                    <span>Timeframe: </span>
                                    <strong>{activeTimeframe().toUpperCase()}</strong>
                                    <span class="hotkey-hint">(Keys: 1-5)</span>
                                </div>
                            </div>
                            <MultiChartGrid 
                                tokens={rankedTokensForGrid()} 
                                onBlockToken={handleBlockToken} 
                                timeframe={activeTimeframe()}
                                viewportState={viewportState()}
                                onViewportChange={handleViewportChange}
                                activeChartId={activeChartId()}
                                onSetActiveChart={setActiveChartId}
                            />
                        </>
                    }
                >
                    <SingleTokenView 
                        token={focusedToken()!} 
                        activeTimeframe={activeTimeframe()} 
                    />
                </Show>
            </div>
        </div>
    );
};

export default ChartPageLayout;