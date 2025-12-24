// packages/frontend/src/hooks/useMarketData.ts
import { createSignal, onMount, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { coreSocket } from '../socket';
// ✨ 引用路径统一：从 local types (其内部 re-export 了 shared-types)
import type { MarketItem, MemeItem, LocalDataPayload, AlertLogEntry as ServerAlertEntry } from '../types';
import { speak } from '../AlertManager';

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
    const [alertLogs, setAlertLogs] = createStore<ServerAlertEntry[]>([]); // ✨ 升级为详细日志
    const [connectionStatus, setConnectionStatus] = createSignal('Connecting...');
    const [lastUpdate, setLastUpdate] = createSignal('N/A');
    const [blockList] = createSignal(loadBlockListFromStorage());

    onMount(() => {
        console.log(`[useMarketData] 🔌 Initializing hook for category: ${targetCategory}`);

        if (!coreSocket.connected) {
            coreSocket.connect();
        }

        const onConnect = () => {
            console.log(`[useMarketData] ✅ CoreSocket Connected. Subscribing to room: ${targetCategory}`);
            setConnectionStatus('Connected');
            coreSocket.emit('subscribe_feed', targetCategory);
        };

        const onDisconnect = () => {
            console.warn(`[useMarketData] ❌ CoreSocket Disconnected (Scope: ${targetCategory})`);
            setConnectionStatus('Disconnected');
        };

        const onDataBroadcast = (payload: LocalDataPayload<T>) => {
            // 🛡️ 严格的数据隔离：防止跨频道数据污染
            if (payload.category !== targetCategory) {
                return;
            }

            if (!payload.data || payload.data.length === 0) return;

            // 1. 报警检测 (已移至后端)
            // if (targetCategory === 'hotlist') { ... }

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

        // 🔥 新增：监听服务器推送的报警历史 (初始化时)
        const onAlertHistory = (history: ServerAlertEntry[]) => {
            console.log(`[Alert] 📜 Received ${history.length} historical alerts`);
            setAlertLogs(history);
        };

        // 🔥 新增：监听服务器推送的新报警
        const onAlertUpdate = (entry: ServerAlertEntry) => {
            console.log(`[Alert] 🚨 New alert: ${entry.message}`);
            speak(entry.message); // 语音播报
            setAlertLogs(produce((logs) => {
                logs.unshift(entry);
                if (logs.length > 50) logs.pop();
            }));
        };

        coreSocket.on('connect', onConnect);
        coreSocket.on('disconnect', onDisconnect);
        coreSocket.on('data-broadcast', onDataBroadcast as any);
        coreSocket.on('alert_history', onAlertHistory);
        coreSocket.on('alert_update', onAlertUpdate);

        if (coreSocket.connected) {
            onConnect();
        }

        onCleanup(() => {
            console.log(`[useMarketData] 🧹 Cleanup: Unsubscribing from ${targetCategory}`);
            if (coreSocket.connected) {
                coreSocket.emit('unsubscribe_feed', targetCategory);
            }
            coreSocket.off('connect', onConnect);
            coreSocket.off('disconnect', onDisconnect);
            coreSocket.off('data-broadcast', onDataBroadcast);
            coreSocket.off('alert_history', onAlertHistory);
            coreSocket.off('alert_update', onAlertUpdate);
        });
    });

    return {
        marketData,
        alertLogs, // ✨ 返回详细日志
        connectionStatus,
        lastUpdate
    };
};