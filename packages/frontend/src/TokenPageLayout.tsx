// packages/frontend/src/TokenPageLayout.tsx
/** @jsxImportSource solid-js */
import { Component, createSignal, onMount, onCleanup, createEffect, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from './socket';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import SingleTokenView from './SingleTokenView';
import { initializeVoices, checkAndTriggerAlerts } from './AlertManager';

const BLOCKLIST_STORAGE_KEY = 'trading-dashboard-blocklist';

// ✨ 1. 引入时间周期常量
const TIMEFRAME_MAP: Record<string, string> = {
    '1': '1m', '2': '5m', '3': '1h', '4': '4h', '5': '1d',
};

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

const TokenPageLayout: Component = () => {
    const [marketData, setMarketData] = createStore<MarketItem[]>([]);
    const [lastUpdate, setLastUpdate] = createSignal('Connecting...');
    const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());
    const [currentToken, setCurrentToken] = createSignal<MarketItem | null>(null);
    // ✨ 2. 创建一个 signal 来管理动态的时间周期，默认是 '5m'
    const [activeTimeframe, setActiveTimeframe] = createSignal('5m'); 

    const getTokenParamsFromURL = () => {
        const params = new URLSearchParams(window.location.search);
        const address = params.get('address');
        const chain = params.get('chain');
        return (address && chain) ? { address, chain } : null;
    };

    const handleNewAlert = (logMessage: string, alertType: 'volume' | 'price') => {
        console.log(`[TokenPage Alert] [${alertType.toUpperCase()}] ${logMessage}`);
    };
    
    // ✨ 3. 创建键盘事件处理器
    const handleKeyDown = (e: KeyboardEvent) => {
        // 忽略在输入框中的按键
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

        // 检查按键是否在我们的映射中 (1, 2, 3, 4, 5)
        if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
            const newTimeframe = TIMEFRAME_MAP[e.key];
            console.log(`[TokenPageLayout] Hotkey '${e.key}' pressed. Changing timeframe to ${newTimeframe}`);
            setActiveTimeframe(newTimeframe);
        }
    };

    onMount(() => {
        if (!socket.connected) socket.connect();
        
        socket.on('connect', () => setLastUpdate('Connected, waiting for data...'));
        socket.on('disconnect', () => setLastUpdate('Disconnected'));
        socket.on('data-broadcast', (payload: DataPayload) => {
            if (!payload.data || payload.data.length === 0) return;
            // ... alert logic unchanged
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
        
        // ✨ 4. 注册和清理事件监听器
        window.addEventListener('keydown', handleKeyDown);
        onCleanup(() => {
            socket.off('connect');
            socket.off('disconnect');
            socket.off('data-broadcast');
            window.removeEventListener('keydown', handleKeyDown);
        });
    });

    // Effect for handling URL changes (unchanged)
    createEffect(() => {
        const params = getTokenParamsFromURL();
        if (marketData.length > 0 && params) {
            const current = currentToken();
            if (current && 
                current.contractAddress.toLowerCase() === params.address.toLowerCase() && 
                current.chain.toLowerCase() === params.chain.toLowerCase()) {
                const updatedTokenData = marketData.find(t => t.contractAddress === current.contractAddress);
                if (updatedTokenData) {
                    setCurrentToken(updatedTokenData);
                }
                return;
            }
            const foundToken = marketData.find(t => 
                t.contractAddress.toLowerCase() === params.address.toLowerCase() && 
                t.chain.toLowerCase() === params.chain.toLowerCase()
            );
            if (foundToken) {
                setCurrentToken(foundToken);
            }
        }
    });

    const handleTokenSelect = (token: MarketItem) => {
        const newUrl = `/token.html?address=${token.contractAddress}&chain=${token.chain}`;
        window.history.pushState({ path: newUrl }, '', newUrl);
        setCurrentToken(token);
    };

    return (
        <div class="chart-page-container">
            <div class="left-sidebar">
                <CompactRankingListsContainer 
                    marketData={marketData}
                    lastUpdate={lastUpdate()} 
                    onHeaderClick={() => {}} 
                    blockList={blockList()}
                    onItemClick={handleTokenSelect}
                />
            </div>
            <div class="right-chart-grid">
                <Show
                    when={currentToken()}
                    fallback={<div class="placeholder">Select a token from the list on the left or provide address/chain in URL.</div>}
                >
                    {/* ✨ 5. 将动态的 activeTimeframe 传递给 SingleTokenView */}
                    <SingleTokenView 
                        token={currentToken()!} 
                        activeTimeframe={activeTimeframe()} 
                    />
                </Show>
            </div>
        </div>
    );
};

export default TokenPageLayout;