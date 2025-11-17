// packages/frontend/src/kline-browser-manager.ts
import * as dbManager from './db-manager';
import type { Kline, LightweightChartKline, KlineData } from './types';
import { socket } from './socket';

const HISTORICAL_API_URL = 'https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval={interval}&limit={limit}&platform={platform}';
const API_MAX_LIMIT = 500;

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

interface KlineUpdatePayload {
    room: string;
    data: LightweightChartKline;
}

class KlineBrowserManager {
    private contractAddress: string;
    private chain: string;
    private interval: string;
    private roomName: string;
    private onDataLoaded: DataCallback | null = null;
    private onUpdate: UpdateCallback | null = null;
    private isSubscribed: boolean = false;

    constructor(contractAddress: string, chain: string, interval: string) {
        this.contractAddress = contractAddress;
        this.chain = chain.toLowerCase();
        this.interval = interval;
        this.roomName = `kl@14@${this.contractAddress}@${this.interval}`;
        console.log(`📈 KlineManager for ${this.roomName} initialized.`);
    }

    private mapToLightweightChartKline(kline: Kline): LightweightChartKline {
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
        const payload = { address: this.contractAddress, chain: this.chain, interval: this.interval };
        socket.emit('subscribe_kline', payload);
        this.isSubscribed = true;
        console.log(`🔼 [SUB] Sent subscribe request for ${this.roomName}`);
    }

    private handleKlineUpdate = (payload: KlineUpdatePayload) => {
        if (payload.room === this.roomName) {
            const tick = {
                ...payload.data,
                timestamp: payload.data.time * 1000,
            } as KlineData;
            
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
        
        if (this.onDataLoaded && cachedKlines.length > 0) {
            console.log(`[Manager ${this.roomName}] 👉 Firing 'onDataLoaded' with ${cachedKlines.length} CACHED candles.`);
            this.onDataLoaded(cachedKlines.map(this.mapToLightweightChartKline));
        } else {
            console.log(`[Manager ${this.roomName}] No cached data to show initially.`);
        }

        const lastKline = cachedKlines.length > 0 ? cachedKlines[cachedKlines.length - 1] : null;
        let fetchLimit = API_MAX_LIMIT;
        let shouldFetch = true;

        if (lastKline) {
            const timeDiff = Date.now() - lastKline.timestamp;
            const intervalMs = intervalToMs(this.interval);
            const missingCandles = Math.ceil(timeDiff / intervalMs);
            if (missingCandles > API_MAX_LIMIT) {
                console.log(`[CACHE ${this.roomName}] Data is too old (${missingCandles} missing). Clearing cache and refetching full ${API_MAX_LIMIT}.`);
                await dbManager.clearKlines(this.contractAddress, this.chain, this.interval);
                fetchLimit = API_MAX_LIMIT;
            } else if (missingCandles <= 1) {
                console.log(`[CACHE ${this.roomName}] Data is up-to-date. No fetch needed.`);
                shouldFetch = false;
            } else {
                fetchLimit = missingCandles; 
                console.log(`[CACHE ${this.roomName}] Missing approx ${missingCandles} candles. Fetching limit=${fetchLimit}.`);
            }
        }

        if (shouldFetch) {
            const newKlines = await this.fetchHistoricalData(fetchLimit);
            if (newKlines.length > 0) {
                await dbManager.saveKlines(newKlines);
                await dbManager.pruneOldKlines(this.contractAddress, this.chain, this.interval);
                
                // ✨ --- 核心优化 --- ✨
                // 如果是首次加载 (没有缓存)，则通过 'data' 事件发送完整数据
                if (cachedKlines.length === 0 && this.onDataLoaded) {
                    let allKlines = await dbManager.getKlines(this.contractAddress, this.chain, this.interval);
                    allKlines.sort((a, b) => a.timestamp - b.timestamp);
                    console.log(`[Manager ${this.roomName}] 👉 Firing 'onDataLoaded' with ${allKlines.length} FRESHLY FETCHED candles.`);
                    this.onDataLoaded(allKlines.map(this.mapToLightweightChartKline));
                } 
                // 如果是补充数据 (已有缓存)，则通过 'update' 事件逐条发送增量数据
                else if (this.onUpdate) {
                    console.log(`[Manager ${this.roomName}] 👉 Firing 'onUpdate' for ${newKlines.length} newly fetched historical candles.`);
                    newKlines.sort((a, b) => a.timestamp - b.timestamp); // 确保按时间顺序更新
                    for (const kline of newKlines) {
                        this.onUpdate(this.mapToLightweightChartKline(kline));
                    }
                }
            }
        }
        
        this.startRealtimeUpdates();
    }

    public stop(): void {
        if (this.isSubscribed) {
            const payload = { address: this.contractAddress, chain: this.chain, interval: this.interval };
            socket.emit('unsubscribe_kline', payload);
            socket.off('kline_update', this.handleKlineUpdate);
            this.isSubscribed = false;
            console.log(`🔽 [UNSUB] Sent unsubscribe request for ${this.roomName}`);
        }
    }
}

export default KlineBrowserManager;