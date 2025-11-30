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

// ✨ 核心修改：强制要求传入 category
export const useMarketData = (targetCategory: 'hotlist' | 'meme_new') => {
    // 这里的 Store 现在只包含特定分类的数据，不再是混合数据
    const [marketData, setMarketData] = createStore<MarketItem[]>([]);
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

        const onDataBroadcast = (payload: DataPayload) => {
            // 🛡️ 安全检查：防止后端广播错误（虽然房间机制已隔离）
            if (payload.category !== targetCategory) {
                 return;
            }

            // ✨✨✨ 调试日志：打印接收到的所有原始数据 ✨✨✨
            if (payload.data && payload.data.length > 0) {
               // console.groupCollapsed(`[Data Received] ${targetCategory} (${payload.data.length} items)`);
               // console.log('Raw Payload Data:', payload.data);
                
                // 专门检查 twitterId
                const itemsWithTwitter = payload.data.filter((item: any) => item.twitterId);
                if (itemsWithTwitter.length > 0) {
                    console.log(`👉 Found ${itemsWithTwitter.length} items with Twitter ID:`, itemsWithTwitter);
                } else {
                    //console.log('❌ No Twitter IDs found in this batch.');
                }
                console.groupEnd();
            }

            if (!payload.data || payload.data.length === 0) return;

            const startTime = performance.now();
            const blocked = blockList();

            // 1. 报警检测 (仅针对不在黑名单的)
            for (const newItem of payload.data) {
                if (!blocked.has(newItem.contractAddress)) {
                    const oldItem = marketData.find(d => 
                        d.contractAddress === newItem.contractAddress && d.chain === newItem.chain
                    );
                    if (oldItem) {
                        checkAndTriggerAlerts(newItem, oldItem, handleAlertLog);
                    }
                }
            }

            // 2. 数据同步 (Upsert / Prune)
            setMarketData(produce(currentData => {
                const incomingIds = new Set<string>();
                let updatedCount = 0;
                let addedCount = 0;
                let removedCount = 0;

                // A. 更新或插入
                for (const rawItem of payload.data) {
                    // 确保 source 字段存在
                    const newItem = { ...rawItem, source: rawItem.source || targetCategory };
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

                // B. 清理 (Prune) - 移除当前房间不再包含的数据
                // 假设后端是 Snapshot 模式（每次推送完整的 Top N）：
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

                const duration = (performance.now() - startTime).toFixed(2);
                if (addedCount > 0 || removedCount > 0 || Number(duration) > 5) {
                    // console.log(`[Sync:${targetCategory}] +${addedCount} ~${updatedCount} -${removedCount} (${duration}ms)`);
                }
            }));

            setLastUpdate(new Date().toLocaleTimeString());
        };

        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        socket.on('data-broadcast', onDataBroadcast);

        // 如果组件加载时 socket 已经是连接状态，手动触发一次订阅
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