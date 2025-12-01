// packages/frontend/src/hooks/useMarketData.ts
import { createSignal, onMount, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from '../socket';
import type { MarketItem } from 'shared-types';
import type { LocalDataPayload, MemeItem } from '../types'; // ✨ 引入本地扩展类型
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

// ✨ 核心修改：支持泛型 T，默认为 MarketItem
// 增加 'meme_migrated' 到允许的 category
export const useMarketData = <T extends MarketItem | MemeItem = MarketItem>(
    targetCategory: 'hotlist' | 'meme_new' | 'meme_migrated'
) => {
    // 这里的 Store 现在只包含特定分类的数据
    const [marketData, setMarketData] = createStore<T[]>([]);
    const [connectionStatus, setConnectionStatus] = createSignal('Connecting...');
    const [lastUpdate, setLastUpdate] = createSignal('N/A');
    const [blockList] = createSignal(loadBlockListFromStorage());

    const handleAlertLog = (msg: string, type: 'volume' | 'price') => {
        console.log(`[Alert System] 🚨 [${type.toUpperCase()}] ${msg}`);
    };

    onMount(() => {
        console.log(`[useMarketData] 🔌 Initializing for category: ${targetCategory}`);
        
        if (!socket.connected) {
            socket.connect();
        }

        const onConnect = () => {
            console.log(`[useMarketData] ✅ Socket Connected. Subscribing to room: ${targetCategory}`);
            setConnectionStatus('Connected');
            // ✨ 关键点：连接后立即加入对应的房间
            socket.emit('subscribe_feed', targetCategory);
        };

        const onDisconnect = () => {
            console.warn(`[useMarketData] ❌ Socket Disconnected (Scope: ${targetCategory})`);
            setConnectionStatus('Disconnected');
        };

        // 使用泛型 Payload
        const onDataBroadcast = (payload: LocalDataPayload<T>) => {
            // 🛡️ 安全检查
            if (payload.category !== targetCategory) {
                 return;
            }

            if (!payload.data || payload.data.length === 0) return;

            const startTime = performance.now();
            const blocked = blockList();

            // 1. 报警检测 (仅针对 Hotlist 类型的 MarketItem，避免 Meme 类型缺少字段报错)
            // 这里做一个简单的 duck typing 检查，只有包含 priceChange 的才检查报警
            if (targetCategory === 'hotlist') {
                for (const newItem of payload.data) {
                    const item = newItem as unknown as MarketItem; // Cast for checking
                    if (!blocked.has(item.contractAddress)) {
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
                    // 确保 source 字段存在
                    const newItem = { ...rawItem, source: rawItem.source || targetCategory } as T;
                    const uniqueId = `${newItem.chain}-${newItem.contractAddress}`;
                    incomingIds.add(uniqueId);

                    const index = currentData.findIndex(d => 
                        d.contractAddress === newItem.contractAddress && d.chain === newItem.chain
                    );

                    if (index > -1) {
                        // ✨ Merge logic: 保留旧对象引用，更新属性
                        Object.assign(currentData[index], newItem);
                        updatedCount++;
                    } else {
                        currentData.push(newItem);
                        addedCount++;
                    }
                }

                // B. 清理 (Prune) - 移除当前房间不再包含的数据
                // 仅当 snapshot 模式时执行清理，增量 update 不清理
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
        // Cast the event handler because Socket.IO types might conflict with our Generic
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