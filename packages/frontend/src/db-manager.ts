// packages/frontend/src/db-manager.ts
import { openDB, IDBPDatabase } from 'idb';
import type { KlineData } from './types'; // ✨ 核心修改: 从 types.ts 导入

const DB_NAME = 'KlineCacheDB';
const DB_VERSION = 1;
const STORE_NAME = 'candles';
const MAX_CANDLES_PER_KEY = 1000;
const PRUNE_TO_COUNT = 500;

let db: IDBPDatabase<any>;

async function initDB(): Promise<IDBPDatabase<any>> {
    if (db) return db;
    db = await openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, {
                    keyPath: ['primaryKey', 'timestamp'],
                });
                store.createIndex('by_primaryKey', 'primaryKey');
            }
        },
    });
    return db;
}

export function getPrimaryKey(address: string, chain: string, interval: string): string {
    return `${address}_${chain.toLowerCase()}_${interval}`;
}

export async function saveKlines(klines: KlineData[]): Promise<void> {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await Promise.all(klines.map(kline => tx.store.put(kline)));
    await tx.done;
}

export async function getLastKline(address: string, chain: string, interval: string): Promise<KlineData | undefined> {
    const db = await initDB();
    const primaryKey = getPrimaryKey(address, chain, interval);
    const cursor = await db.transaction(STORE_NAME).store
        .index('by_primaryKey')
        .openCursor(IDBKeyRange.only(primaryKey), 'prev');
    return cursor?.value;
}

export async function getKlines(address: string, chain: string, interval: string): Promise<KlineData[]> {
    const db = await initDB();
    const primaryKey = getPrimaryKey(address, chain, interval);
    return db.getAllFromIndex(STORE_NAME, 'by_primaryKey', primaryKey);
}

export async function clearKlines(address: string, chain: string, interval: string): Promise<void> {
    console.log(`[DB] Clearing all klines for ${address} on interval ${interval}`);
    const db = await initDB();
    const primaryKey = getPrimaryKey(address, chain, interval);
    const keys = await db.getAllKeysFromIndex(STORE_NAME, 'by_primaryKey', primaryKey);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await Promise.all(keys.map(key => tx.store.delete(key)));
    await tx.done;
}

export async function pruneOldKlines(address: string, chain: string, interval: string): Promise<void> {
    const db = await initDB();
    const primaryKey = getPrimaryKey(address, chain, interval);
    const allKlines = await db.getAllFromIndex(STORE_NAME, 'by_primaryKey', primaryKey);

    if (allKlines.length > MAX_CANDLES_PER_KEY) {
        console.log(`[DB] Pruning klines for ${primaryKey}. Current count: ${allKlines.length}`);
        allKlines.sort((a, b) => b.timestamp - a.timestamp);
        
        const klinesToDelete = allKlines.slice(PRUNE_TO_COUNT);
        
        const tx = db.transaction(STORE_NAME, 'readwrite');
        await Promise.all(klinesToDelete.map(kline => tx.store.delete([kline.primaryKey, kline.timestamp])));
        await tx.done;
        
        console.log(`[DB] Pruning complete. Deleted ${klinesToDelete.length} old klines.`);
    }
}