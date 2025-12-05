// packages/frontend/src/hooks/useMarketData.ts
import { createSignal, onMount, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from '../socket';
// ✨ 引用路径统一：从 local types (其内部 re-export 了 shared-types)
import type { MarketItem, MemeItem, LocalDataPayload } from '../types';
import { checkAndTriggerAlerts } from '../AlertManager';

const loadBlockListFromStorage = (): Set<string> => {
    try {
        const storedList = localStorage.getItem('trading-dashboard-blocklist');
        if (storedList) {
            const parsedArray = JSON.parse(storedList);
            if (Array.isArray(parsedArray)) return new Set(parsedArray);
        }
    } catch (error) { console.error('[Blocklist] Failed to load:', error); }
    return new Set();
};

// 🌟 泛型支持：允许 hook 服务于 Hotlist 或 MemeItem
export const useMarketData = <T extends MarketItem | MemeItem = MarketItem>(
    targetCategory: 'hotlist' | 'meme_new' | 'meme_migrated'
) => {
    const [marketData, setMarketData] = createStore<T[]>([]);
    const [connectionStatus, setConnectionStatus] = createSignal('Connecting...');
    const [lastUpdate, setLastUpdate] = createSignal('N/A');
    const [blockList] = createSignal(loadBlockListFromStorage());

    const handleAlertLog = (msg: string, type: 'volume' | 'price') => {
        console.log(`[Alert System] 🚨 [${type.toUpperCase()}] ${msg}`);
    };

    onMount(() => {
        console.log(`[useMarketData] 🔌 Initializing hook for category: ${targetCategory}`);
        
        if (!socket.connected) {
            socket.connect();
        }

        const onConnect = () => {
            console.log(`[useMarketData] ✅ Socket Connected. Subscribing to room: ${targetCategory}`);
            setConnectionStatus('Connected');
            socket.emit('subscribe_feed', targetCategory);
        };

        const onDisconnect = () => {
            console.warn(`[useMarketData] ❌ Socket Disconnected (Scope: ${targetCategory})`);
            setConnectionStatus('Disconnected');
        };

        const onDataBroadcast = (payload: LocalDataPayload<T>) => {
            // 🛡️ 严格的数据隔离：防止跨频道数据污染
            if (payload.category !== targetCategory) {
                 return;
            }

            if (!payload.data || payload.data.length === 0) return;

            const startTime = performance.now();
            const blocked = blockList();

            // 1. 报警检测 (仅针对 Hotlist 类型的 MarketItem)
            if (targetCategory === 'hotlist') {
                for (const newItem of payload.data) {
                    // 使用 Duck Typing 安全地转换类型以检查是否需要报警
                    // 实际项目中可以加更严谨的 Type Guard
                    const item = newItem as unknown as MarketItem; 
                    
                    // 只有包含 source='hotlist' 且不在黑名单的数据才进行报警检查
                    if ('source' in item && item.source === 'hotlist' && !blocked.has(item.contractAddress)) {
                        const oldItem = (marketData as unknown as MarketItem[]).find(d => 
                            d.contractAddress === item.contractAddress && d.chain === item.chain
                        );
                        if (oldItem) {
                            checkAndTriggerAlerts(item, oldItem, handleAlertLog);
                        }
                    }
                }
            }

            // 2. 数据同步 (Upsert / Prune)
            setMarketData(produce((currentData: T[]) => {
                const incomingIds = new Set<string>();
                let updatedCount = 0;
                let addedCount = 0;
                let removedCount = 0;

                // A. 更新或插入
                for (const rawItem of payload.data) {
                    const newItem = { ...rawItem, source: rawItem.source || targetCategory } as T;
                    const uniqueId = `${newItem.chain}-${newItem.contractAddress}`;
                    incomingIds.add(uniqueId);

                    const index = currentData.findIndex(d => 
                        d.contractAddress === newItem.contractAddress && d.chain === newItem.chain
                    );

                    if (index > -1) {
                        // ✨ Merge logic: 更新现有对象
                        Object.assign(currentData[index], newItem);
                        updatedCount++;
                    } else {
                        currentData.push(newItem);
                        addedCount++;
                    }
                }

                // B. 清理 (Prune) - 仅在 Snapshot 模式下清理
                if (payload.type === 'snapshot') {
                    for (let i = currentData.length - 1; i >= 0; i--) {
                        const item = currentData[i];
                        const uniqueId = `${item.chain}-${item.contractAddress}`;
                        
                        if (!incomingIds.has(uniqueId)) {
                            currentData.splice(i, 1);
                            removedCount++;
                        }
                    }
                }
            }));

            setLastUpdate(new Date().toLocaleTimeString());
        };

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on('data-broadcast', onDataBroadcast as any);

        if (socket.connected) {
            onConnect();
        }

        onCleanup(() => {
            console.log(`[useMarketData] 🧹 Cleanup: Unsubscribing from ${targetCategory}`);
            if (socket.connected) {
                socket.emit('unsubscribe_feed', targetCategory);
            }
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
            socket.off('data-broadcast', onDataBroadcast);
        });
    });

    return {
        marketData,
        connectionStatus,
        lastUpdate
    };
};