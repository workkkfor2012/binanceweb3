// packages/frontend/src/hooks/useMarketData.ts
import { createSignal, onMount, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { coreSocket, marketSocket } from '../socket.js';
// ✨ 引用路径统一：从 local types (其内部 re-export 了 shared-types)
import type { MarketItem, MemeItem, LocalDataPayload, AlertLogEntry as ServerAlertEntry } from '../types.js';
import { speak } from '../AlertManager.js';

// ✨ 不再使用 localStorage，改由后端同步



// 🌟 泛型支持：允许 hook 服务于 Hotlist 或 MemeItem
export const useMarketData = <T extends MarketItem | MemeItem = MarketItem>(
    targetCategory: 'hotlist' | 'meme_new' | 'meme_migrated'
) => {
    const [marketData, setMarketData] = createStore<T[]>([]);
    const [alertLogs, setAlertLogs] = createStore<ServerAlertEntry[]>([]); // ✨ 升级为详细日志
    const [connectionStatus, setConnectionStatus] = createSignal('Connecting...');
    const [lastUpdate, setLastUpdate] = createSignal('N/A');
    const [blacklist, setBlacklist] = createSignal<Set<string>>(new Set());

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

        // 🔥 新增：监听本地后端返回的叙事数据
        const onNarrativeResponse = (data: { address: string; narrative: string }) => {
            setMarketData(produce((currentData: T[]) => {
                const index = currentData.findIndex(d => d.contractAddress === data.address);
                if (index > -1) {
                    (currentData[index] as any).narrative = data.narrative;
                }
            }));
        };

        // ✨ 新增：监听服务器推送的黑名单
        const onBlacklistInit = (list: string[]) => {
            console.log(`[Blacklist] 🚫 Initialized with ${list.length} entries`);
            setBlacklist(new Set(list));
        };

        const onBlacklistUpdate = (update: { action: 'add' | 'remove', address: string }) => {
            console.log(`[Blacklist] 🔄 Reactive Update Received: ${update.action} ${update.address}`);
            setBlacklist(prev => {
                const next = new Set(prev);
                if (update.action === 'add') {
                    next.add(update.address);

                    // ✨ 响应式处理：立即从数据列表中剔除
                    console.log(`[Blacklist] 🧹 Removing ${update.address} from marketData and logs`);
                    setMarketData(produce((currentData: T[]) => {
                        const index = currentData.findIndex(d => d.contractAddress === update.address);
                        if (index > -1) currentData.splice(index, 1);
                    }));

                    setAlertLogs(produce((logs) => {
                        // 过滤掉该合约的所有报警
                        const filtered = logs.filter(l => l.contractAddress === update.address);
                        if (filtered.length > 0) {
                            console.log(`[Blacklist] 🗑️ Cleaned up ${filtered.length} alert logs for ${update.address}`);
                            const final = logs.filter(l => l.contractAddress !== update.address);
                            logs.length = 0;
                            logs.push(...final);
                        }
                    }));
                } else {
                    next.delete(update.address);
                }
                return next;
            });
        };

        coreSocket.on('connect', onConnect);
        coreSocket.on('disconnect', onDisconnect);
        coreSocket.on('data-broadcast', onDataBroadcast as any);
        coreSocket.on('alert_history', onAlertHistory);
        coreSocket.on('alert_update', onAlertUpdate);
        coreSocket.on('blacklist_init', onBlacklistInit);
        coreSocket.on('blacklist_update', onBlacklistUpdate);
        marketSocket.on('narrative_response', onNarrativeResponse);

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
            coreSocket.off('blacklist_init', onBlacklistInit);
            coreSocket.off('blacklist_update', onBlacklistUpdate);
            marketSocket.off('narrative_response', onNarrativeResponse);
        });
    });

    return {
        marketData,
        alertLogs, // ✨ 返回详细日志
        blacklist, // ✨ 返回同步后的黑名单
        connectionStatus,
        lastUpdate
    };
};