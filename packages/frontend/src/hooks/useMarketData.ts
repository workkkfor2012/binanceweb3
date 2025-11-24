// packages/frontend/src/hooks/useMarketData.ts
import { createSignal, onMount, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { socket } from '../socket';
import type { MarketItem, DataPayload } from 'shared-types';
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

export const useMarketData = () => {
    const [marketData, setMarketData] = createStore<MarketItem[]>([]);
    const [connectionStatus, setConnectionStatus] = createSignal('Connecting...');
    const [lastUpdate, setLastUpdate] = createSignal('N/A');
    const [blockList] = createSignal(loadBlockListFromStorage()); // 仅用于报警过滤，不用于数据过滤

    // 报警日志回调
    const handleAlertLog = (msg: string, type: 'volume' | 'price') => {
        console.log(`[Alert System] 🚨 [${type.toUpperCase()}] ${msg}`);
    };

    onMount(() => {
        console.log('[useMarketData] 🔌 Initializing socket connection...');
        
        if (!socket.connected) {
            socket.connect();
        }

        const onConnect = () => {
            console.log('[useMarketData] ✅ Socket Connected');
            setConnectionStatus('Connected, waiting for data...');
        };

        const onDisconnect = () => {
            console.warn('[useMarketData] ❌ Socket Disconnected');
            setConnectionStatus('Disconnected');
        };

        // 📡 核心全量同步逻辑
        const onDataBroadcast = (payload: DataPayload) => {
            if (!payload.data || payload.data.length === 0) return;

            const startTime = performance.now();
            const blocked = blockList();

            // 1. 报警检测 (Alert Check) - 在更新 Store 之前对比
            // 只有不在黑名单的币种才触发报警
            for (const newItem of payload.data) {
                if (!blocked.has(newItem.contractAddress)) {
                    // 在现有 Store 中查找旧数据
                    const oldItem = marketData.find(d => 
                        d.contractAddress === newItem.contractAddress && d.chain === newItem.chain
                    );
                    if (oldItem) {
                        checkAndTriggerAlerts(newItem, oldItem, handleAlertLog);
                    }
                }
            }

            // 2. 数据同步 (Sync Store)
            setMarketData(produce(currentData => {
                const incomingIds = new Set<string>();
                let updatedCount = 0;
                let addedCount = 0;
                let removedCount = 0;

                // A. 更新或插入 (Upsert)
                for (const newItem of payload.data) {
                    // 构建复合唯一键用于 Pruning 检查
                    const uniqueId = `${newItem.chain}-${newItem.contractAddress}`;
                    incomingIds.add(uniqueId);

                    const index = currentData.findIndex(d => 
                        d.contractAddress === newItem.contractAddress && d.chain === newItem.chain
                    );

                    if (index > -1) {
                        Object.assign(currentData[index], newItem);
                        updatedCount++;
                    } else {
                        currentData.push(newItem);
                        addedCount++;
                    }
                }

                // B. 清理 (Prune) - 移除后端不再包含的数据
                // 倒序遍历以安全删除
                for (let i = currentData.length - 1; i >= 0; i--) {
                    const item = currentData[i];
                    const uniqueId = `${item.chain}-${item.contractAddress}`;
                    if (!incomingIds.has(uniqueId)) {
                        console.log(`[useMarketData] 🗑️ Pruning stale token: ${item.symbol}`);
                        currentData.splice(i, 1);
                        removedCount++;
                    }
                }
                
                // 性能日志 (仅在有变动或耗时较长时打印)
                const duration = (performance.now() - startTime).toFixed(2);
                if (addedCount > 0 || removedCount > 0 || Number(duration) > 5) {
                    console.log(`[Sync] ${payload.data.length} items (Add:${addedCount} Upd:${updatedCount} Del:${removedCount}) in ${duration}ms`);
                }
            }));

            setLastUpdate(new Date().toLocaleTimeString());
        };

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on('data-broadcast', onDataBroadcast);

        onCleanup(() => {
            console.log('[useMarketData] 🧹 Cleaning up listeners');
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