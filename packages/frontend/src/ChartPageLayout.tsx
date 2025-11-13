// packages/frontend/src/ChartPageLayout.tsx
import { Component, createSignal, onMount, onCleanup, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { io, Socket } from 'socket.io-client';
import type { MarketItem, DataPayload } from 'shared-types';
import CompactRankingListsContainer from './CompactRankingListsContainer';
import MultiChartGrid from './MultiChartGrid';

const BACKEND_URL = 'http://localhost:3001';
const BLOCKLIST_STORAGE_KEY = 'trading-dashboard-blocklist'; // 定义一个 localStorage 的键

// ✨ 新增: 从 localStorage 加载黑名单的辅助函数
const loadBlockListFromStorage = (): Set<string> => {
    try {
        const storedList = localStorage.getItem(BLOCKLIST_STORAGE_KEY);
        if (storedList) {
            // 解析 JSON 字符串，并将其转换为 Set
            const parsedArray = JSON.parse(storedList);
            if (Array.isArray(parsedArray)) {
                return new Set(parsedArray);
            }
        }
    } catch (error) {
        console.error('[Blocklist] Failed to load or parse blocklist from localStorage:', error);
    }
    // 如果失败或不存在，返回一个空的 Set
    return new Set();
};

// ✨ 新增: 将黑名单保存到 localStorage 的辅助函数
const saveBlockListToStorage = (blockList: Set<string>): void => {
    try {
        // 将 Set 转换为 Array，然后序列化为 JSON 字符串
        const arrayToStore = Array.from(blockList);
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(arrayToStore));
    } catch (error) {
        console.error('[Blocklist] Failed to save blocklist to localStorage:', error);
    }
};


const ChartPageLayout: Component = () => {
    const [marketData, setMarketData] = createStore<MarketItem[]>([]);
    const [lastUpdate, setLastUpdate] = createSignal('Connecting...');
    
    const [activeRankBy, setActiveRankBy] = createSignal<keyof MarketItem | null>(null);
    
    // ✨ 核心修改: 初始化时调用 loadBlockListFromStorage
    const [blockList, setBlockList] = createSignal(loadBlockListFromStorage());

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

    // ✨ 核心修改: 屏蔽函数现在也会写入 localStorage
    const handleBlockToken = (contractAddress: string) => {
        const newBlockList = new Set(blockList());
        newBlockList.add(contractAddress);
        
        setBlockList(newBlockList); // 更新组件状态
        saveBlockListToStorage(newBlockList); // 持久化到 localStorage

        console.log(`[Blocklist] Token ${contractAddress} added. New list saved to localStorage.`);
    };
    
    const rankedTokensForGrid = createMemo(() => {
        const rankBy = activeRankBy();
        const blocked = blockList(); 
        
        if (!rankBy) {
            return [];
        }
        
        console.log(`[Re-ranking] Recalculating for "${rankBy}". Blocked items: ${blocked.size}`);

        return [...marketData]
            .filter(item => !blocked.has(item.contractAddress))
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
                <MultiChartGrid 
                    tokens={rankedTokensForGrid()} 
                    onBlockToken={handleBlockToken} 
                />
            </div>
        </div>
    );
};

export default ChartPageLayout;