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

    const getTokenParamsFromURL = () => {
        const params = new URLSearchParams(window.location.search);
        const address = params.get('address');
        const chain = params.get('chain');
        return (address && chain) ? { address, chain } : null;
    };

    const handleNewAlert = (logMessage: string, alertType: 'volume' | 'price') => {
        console.log(`[TokenPage Alert] [${alertType.toUpperCase()}] ${logMessage}`);
    };

    onMount(() => {
        if (!socket.connected) socket.connect();
        
        socket.on('connect', () => setLastUpdate('Connected, waiting for data...'));
        socket.on('disconnect', () => setLastUpdate('Disconnected'));
        socket.on('data-broadcast', (payload: DataPayload) => {
            if (!payload.data || payload.data.length === 0) return;
            // ... (alert logic is unchanged)
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

        onCleanup(() => {
            socket.off('connect');
            socket.off('disconnect');
            socket.off('data-broadcast');
        });
    });

    // ✨ 核心修复: 优化 Effect 逻辑，防止不必要的重渲染
    createEffect(() => {
        const params = getTokenParamsFromURL();
        if (marketData.length > 0 && params) {
            const current = currentToken();

            // 检查当前 token 是否已匹配 URL 参数
            if (current && 
                current.contractAddress.toLowerCase() === params.address.toLowerCase() && 
                current.chain.toLowerCase() === params.chain.toLowerCase()) {
                
                // 如果是同一个 token, 只需从 store 中找到最新的数据对象并更新 signal 即可
                // 这可以确保子组件能接收到最新的价格等信息，但不会触发整个图表的重新加载
                const updatedTokenData = marketData.find(t => t.contractAddress === current.contractAddress);
                if (updatedTokenData) {
                    // console.log(`[TokenPageLayout] Silently updating data for ${current.symbol}`);
                    setCurrentToken(updatedTokenData);
                }
                return; // 关键：提前返回，避免不必要的重新查找和设置
            }

            // 如果代码执行到这里，说明需要加载一个全新的 token
            console.log(`[TokenPageLayout] Attempting to find and set a NEW token based on URL:`, params);
            const foundToken = marketData.find(t => 
                t.contractAddress.toLowerCase() === params.address.toLowerCase() && 
                t.chain.toLowerCase() === params.chain.toLowerCase()
            );

            if (foundToken) {
                console.log(`[TokenPageLayout] ✅ Success! Found and setting new token: ${foundToken.symbol}`);
                setCurrentToken(foundToken);
            } else {
                console.warn(`[TokenPageLayout] ⚠️ Token from URL not found in market data yet.`);
            }
        }
    });

    const handleTokenSelect = (token: MarketItem) => {
        console.log(`[TokenPageLayout] User selected a new token from rankings: ${token.symbol}`);
        const newUrl = `/token.html?address=${token.contractAddress}&chain=${token.chain}`;
        window.history.pushState({ path: newUrl }, '', newUrl);
        // 手动设置, 因为 popstate 事件不会立即触发 effect
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