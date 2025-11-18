// packages/frontend/src/kline-browser-manager.ts
import * as dbManager from './db-manager';
import type { KlineData, LightweightChartKline, KlineUpdatePayload } from './types';
import { socket } from './socket';

const HISTORICAL_API_URL = 'https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval={interval}&limit={limit}&platform={platform}';
const API_MAX_LIMIT = 500;

const CHAIN_CONFIG: Record<string, { internalPoolId: number }> = {
    bsc: { internalPoolId: 14 },
    sol: { internalPoolId: 16 },
    solana: { internalPoolId: 16 }, 
    base: { internalPoolId: 199 }
};

type DataCallback = (data: LightweightChartKline[]) => void;
type UpdateCallback = (data: LightweightChartKline) => void;

function intervalToMs(interval: string): number {
    const value = parseInt(interval);
    const unit = interval.slice(String(value).length);
    if (unit === 'm') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
    return 0;
}

function formatIntervalForApi(interval: string): string {
    if (interval.endsWith('m')) {
        return interval + 'in';
    }
    return interval;
}

class KlineBrowserManager {
    private contractAddress: string;
    private chain: string;
    private interval: string;
    // private symbol: string; // <-- 移除
    private roomName: string;
    private onDataLoaded: DataCallback | null = null;
    private onUpdate: UpdateCallback | null = null;
    private isSubscribed: boolean = false;

    // <-- 构造函数恢复原状
    constructor(contractAddress: string, chain: string, interval: string) {
        this.contractAddress = contractAddress;
        this.chain = chain.toLowerCase();
        this.interval = interval;
        
        const poolId = CHAIN_CONFIG[this.chain]?.internalPoolId;
        if (!poolId) {
            console.error(`❌ [KlineManager] Unsupported chain: ${this.chain}. Cannot construct room name.`);
            this.roomName = 'invalid-room';
        } else {
            this.roomName = `kl@${poolId}@${this.contractAddress}@${this.interval}`;
        }
        
        console.log(`📈 KlineManager for ${this.roomName} initialized.`);
    }

    private mapToLightweightChartKline(kline: KlineData): LightweightChartKline {
        return {
            time: kline.timestamp / 1000,
            open: kline.open,
            high: kline.high,
            low: kline.low,
            close: kline.close,
        };
    }
    
    private async fetchHistoricalData(limit: number): Promise<KlineData[]> {
        const platform = this.chain;
        const apiInterval = formatIntervalForApi(this.interval);
        const url = HISTORICAL_API_URL
            .replace('{address}', this.contractAddress)
            .replace('{platform}', platform)
            .replace('{interval}', apiInterval)
            .replace('{limit}', limit.toString());

        console.log(`[HISTORICAL ${this.roomName}] Fetching ${limit} candles from ${url}...`);
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const json: any = await response.json();
            if (json && Array.isArray(json.data)) {
                const primaryKey = dbManager.getPrimaryKey(this.contractAddress, this.chain, this.interval);
                const klines = json.data.map((d: (string|number)[]): KlineData => ({
                    primaryKey, address: this.contractAddress, chain: this.chain, interval: this.interval,
                    open: parseFloat(String(d[0])), high: parseFloat(String(d[1])),
                    low: parseFloat(String(d[2])), close: parseFloat(String(d[3])),
                    volume: parseFloat(String(d[4])), timestamp: Number(d[5]),
                    time: Number(d[5]) / 1000
                }));
                console.log(`✅ [HISTORICAL ${this.roomName}] Fetched ${klines.length} candles.`);
                return klines;
            }
        } catch (error) { console.error(`❌ [HISTORICAL ${this.roomName}] Failed to fetch data:`, error); }
        return [];
    }
    
    private startRealtimeUpdates(): void {
        if (this.isSubscribed) return;
        socket.on('kline_update', this.handleKlineUpdate);
        
        // <-- payload 恢复原状
        const payload = { 
            address: this.contractAddress, 
            chain: this.chain, 
            interval: this.interval,
        };
        socket.emit('subscribe_kline', payload);
        this.isSubscribed = true;
        console.log(`🔼 [SUB] Sent subscribe request for ${this.roomName}`);
    }

    private handleKlineUpdate = (payload: KlineUpdatePayload) => {
        if (payload.room === this.roomName) {
            // console.log(`✅ [RT ${this.roomName}] Room match! Received update:`, payload.data);
            if (this.onUpdate) {
                this.onUpdate(payload.data);
            }
        }
    };

    public on(event: 'data' | 'update', callback: DataCallback | UpdateCallback): void {
        if (event === 'data') this.onDataLoaded = callback as DataCallback;
        else if (event === 'update') this.onUpdate = callback as UpdateCallback;
    }

    public async start(): Promise<void> {
        let cachedKlines = await dbManager.getKlines(this.contractAddress, this.chain, this.interval);
        cachedKlines.sort((a, b) => a.timestamp - b.timestamp);

        const lastKline = cachedKlines.length > 0 ? cachedKlines[cachedKlines.length - 1] : null;
        let fetchLimit = API_MAX_LIMIT;
        let shouldFetch = true;

        if (lastKline) {
            const timeDiff = Date.now() - lastKline.timestamp;
            const intervalMs = intervalToMs(this.interval);
            const missingCandles = Math.floor(timeDiff / intervalMs) + 1;
            
            if (missingCandles > API_MAX_LIMIT) {
                console.log(`[CACHE ${this.roomName}] Data is too old (${missingCandles} missing). Clearing cache and refetching full ${API_MAX_LIMIT}.`);
                await dbManager.clearKlines(this.contractAddress, this.chain, this.interval);
                cachedKlines = []; 
                fetchLimit = API_MAX_LIMIT;
            } else if (missingCandles <= 1) {
                console.log(`[CACHE ${this.roomName}] Data is up-to-date. No fetch needed.`);
                shouldFetch = false;
            } else {
                fetchLimit = missingCandles > API_MAX_LIMIT ? API_MAX_LIMIT : missingCandles;
                console.log(`[CACHE ${this.roomName}] Missing approx ${missingCandles} candles. Fetching limit=${fetchLimit}.`);
            }
        }

        let allKlines = cachedKlines;
        if (shouldFetch) {
            const newKlines = await this.fetchHistoricalData(fetchLimit);
            if (newKlines.length > 0) {
                const klineMap = new Map<number, KlineData>();
                for (const kline of cachedKlines) { klineMap.set(kline.timestamp, kline); }
                for (const kline of newKlines) { klineMap.set(kline.timestamp, kline); }
                allKlines = Array.from(klineMap.values()).sort((a, b) => a.timestamp - b.timestamp);
                await dbManager.saveKlines(allKlines);
                await dbManager.pruneOldKlines(this.contractAddress, this.chain, this.interval);
            }
        }

        if (this.onDataLoaded) {
            if (allKlines.length > 0) {
                console.log(`[Manager ${this.roomName}] 👉 Firing 'onDataLoaded' with ${allKlines.length} finalized candles.`);
                this.onDataLoaded(allKlines.map(this.mapToLightweightChartKline));
            } else {
                 console.log(`[Manager ${this.roomName}] No data to display.`);
                 this.onDataLoaded([]);
            }
        }
        
        this.startRealtimeUpdates();
    }

    public stop(): void {
        if (this.isSubscribed) {
            const payload = { address: this.contractAddress, chain: this.chain, interval: this.interval }; // <-- unsubscribe 也恢复原状
            socket.emit('unsubscribe_kline', payload);
            socket.off('kline_update', this.handleKlineUpdate);
            this.isSubscribed = false;
            console.log(`🔽 [UNSUB] Sent unsubscribe request for ${this.roomName}`);
        }
    }
}

export default KlineBrowserManager;