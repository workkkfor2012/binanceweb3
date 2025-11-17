// packages/frontend/src/TokenPageLayout.tsx
/** @jsxImportSource solid-js */
import { Component, createSignal, onMount, onCleanup, createEffect, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from './socket';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import SingleTokenView from './SingleTokenView';
import { initializeVoices, checkAndTriggerAlerts } from './AlertManager';
// 移除 KlineBrowserManager 的导入，因为此组件不再直接管理它

const BLOCKLIST_STORAGE_KEY = 'trading-dashboard-blocklist';

const TIMEFRAME_MAP: Record<string, string> = {
    '1': '1m', '2': '5m', '3': '1h', '4': '4h', '5': '1d',
};
const ALL_TIMEFRAMES = Object.values(TIMEFRAME_MAP);

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
    const [activeTimeframe, setActiveTimeframe] = createSignal('5m'); 

    // --- 核心修复: 移除有问题的预缓存逻辑 ---
    // let lastPreCachedAddress: string | null = null;
    /*
    const preCacheAllTimeframes = (token: MarketItem) => {
        if (token.contractAddress === lastPreCachedAddress) {
            console.log(`[TokenPageLayout] Pre-caching for ${token.symbol} already initiated. Skipping.`);
            return;
        }
        console.log(`[TokenPageLayout] 🚀 Initiating pre-caching for all timeframes for ${token.symbol}...`);
        lastPreCachedAddress = token.contractAddress;

        // 这个循环创建了多个“孤儿”KlineBrowserManager实例。
        // 它们发起了WebSocket订阅，但从未被清理，导致了资源泄漏和混乱的订阅/取消订阅日志。
        // 正确的做法是让负责显示图表的组件（SingleKlineChart）全权管理自己的数据加载和生命周期。
        for (const tf of ['1m']) { 
            new KlineBrowserManager(token.contractAddress, token.chain, tf).start();
        }
    };
    */

    const getTokenParamsFromURL = () => {
        const params = new URLSearchParams(window.location.search);
        const address = params.get('address');
        const chain = params.get('chain');
        return (address && chain) ? { address, chain } : null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        if (Object.keys(TIMEFRAME_MAP).includes(e.key)) {
            const newTimeframe = TIMEFRAME_MAP[e.key];
            setActiveTimeframe(newTimeframe);
        }
    };

    onMount(() => {
        if (!socket.connected) socket.connect();
        
        socket.on('data-broadcast', (payload: DataPayload) => {
            if (!payload.data || payload.data.length === 0) return;
            setMarketData(produce(currentData => {
                for (const item of payload.data) {
                    const index = currentData.findIndex(d => d.contractAddress === item.contractAddress && d.chain === item.chain);
                    if (index > -1) Object.assign(currentData[index], item);
                    else currentData.push(item);
                }
            }));
            setLastUpdate(new Date().toLocaleTimeString());
        });
        
        window.addEventListener('keydown', handleKeyDown);
        onCleanup(() => {
            window.removeEventListener('keydown', handleKeyDown);
        });
    });

    createEffect(() => {
        const params = getTokenParamsFromURL();
        if (marketData.length > 0 && params) {
            const current = currentToken();
            if (current && 
                current.contractAddress.toLowerCase() === params.address.toLowerCase() && 
                current.chain.toLowerCase() === params.chain.toLowerCase()) {
                const updatedTokenData = marketData.find(t => t.contractAddress === current.contractAddress);
                if (updatedTokenData) setCurrentToken(updatedTokenData);
                return;
            }
            const foundToken = marketData.find(t => 
                t.contractAddress.toLowerCase() === params.address.toLowerCase() && 
                t.chain.toLowerCase() === params.chain.toLowerCase()
            );
            if (foundToken) {
                setCurrentToken(foundToken);
                // --- 核心修复: 移除此处的调用 ---
                // preCacheAllTimeframes(foundToken); 
            }
        }
    });

    const handleTokenSelect = (token: MarketItem) => {
        const newUrl = `/token.html?address=${token.contractAddress}&chain=${token.chain}`;
        window.history.pushState({ path: newUrl }, '', newUrl);
        setCurrentToken(token);
        // --- 核心修复: 移除此处的调用 ---
        // preCacheAllTimeframes(token);
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