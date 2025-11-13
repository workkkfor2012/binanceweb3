// packages/frontend/src/kline-browser-manager.ts
import * as dbManager from './db-manager';
import type { Kline, LightweightChartKline, KlineData } from './types';

const HISTORICAL_API_URL = 'https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval={interval}&limit={limit}&platform={platform}';
const WEBSOCKET_URL = 'wss://nbstream.binance.com/w3w/stream';
const API_MAX_LIMIT = 500;

type DataCallback = (data: LightweightChartKline[]) => void;
type UpdateCallback = (data: LightweightChartKline) => void;

// 辅助函数：将时间周期字符串转换为毫秒数，用于计算差值
function intervalToMs(interval: string): number {
    const value = parseInt(interval);
    const unit = interval.slice(String(value).length);
    if (unit === 'm') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
    return 0;
}

// ✨ 新增辅助函数：适配 API 的 interval 格式 (1m -> 1min, 5m -> 5min)
function formatIntervalForApi(interval: string): string {
    // 如果是以 'm' 结尾（如 1m, 5m, 15m），则追加 'in' 变为 1min, 5min
    if (interval.endsWith('m')) {
        return interval + 'in';
    }
    // 其他如 1h, 4h, 1d 保持不变
    return interval;
}

class KlineBrowserManager {
    private contractAddress: string;
    private chain: string;
    private interval: string;
    private ws: WebSocket | null = null;
    private onDataLoaded: DataCallback | null = null;
    private onUpdate: UpdateCallback | null = null;

    constructor(contractAddress: string, chain: string, interval: string) {
        this.contractAddress = contractAddress;
        this.chain = chain.toLowerCase();
        this.interval = interval;
        console.log(`📈 KlineManager for ${this.contractAddress} on ${this.chain} (${this.interval}) initialized.`);
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
    
    // ✨ 核心修改: 移除 startTime, 改为接收 limit 参数
    private async fetchHistoricalData(limit: number): Promise<KlineData[]> {
        const platform = this.chain;
        // 使用新函数转换 interval 格式
        const apiInterval = formatIntervalForApi(this.interval);

        const url = HISTORICAL_API_URL
            .replace('{address}', this.contractAddress)
            .replace('{platform}', platform)
            .replace('{interval}', apiInterval) // 使用 1min, 5min 等
            .replace('{limit}', limit.toString()); // 动态设置 limit

        console.log(`[HISTORICAL] Fetching ${limit} candles from ${url}...`);
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
                console.log(`✅ [HISTORICAL] Fetched ${klines.length} candles.`);
                return klines;
            }
        } catch (error) {
            console.error('❌ [HISTORICAL] Failed to fetch data:', error);
        }
        return [];
    }

    private startRealtimeUpdates(): void {
        this.ws = new WebSocket(WEBSOCKET_URL);

        this.ws.onopen = () => {
            if (!this.ws) return;
            const subscribeMessage = { 
                id: `sub-${Date.now()}`, method: 'SUBSCRIBE', 
                params: [`kl@14@${this.contractAddress}@${this.interval}`] 
            };
            this.ws.send(JSON.stringify(subscribeMessage));
        };

        this.ws.onmessage = async (event) => {
            const message = JSON.parse(event.data.toString());
            if (message.stream?.startsWith('kl@')) {
                const tickArray = message.data.d.u;
                const primaryKey = dbManager.getPrimaryKey(this.contractAddress, this.chain, this.interval);
                const tick: KlineData = {
                    primaryKey, address: this.contractAddress, chain: this.chain, interval: this.interval,
                    open: parseFloat(tickArray[0]), high: parseFloat(tickArray[1]),
                    low: parseFloat(tickArray[2]), close: parseFloat(tickArray[3]),
                    volume: parseFloat(tickArray[4]), timestamp: parseInt(tickArray[5], 10),
                    time: parseInt(tickArray[5], 10) / 1000
                };
                
                await dbManager.saveKlines([tick]);
                await dbManager.pruneOldKlines(this.contractAddress, this.chain, this.interval);
                
                if (this.onUpdate) {
                    this.onUpdate(this.mapToLightweightChartKline(tick));
                }
            }
        };

        this.ws.onclose = (event) => {
            if (this.ws) setTimeout(() => this.startRealtimeUpdates(), 5000);
        };
        this.ws.onerror = (event) => console.error('❌ [REALTIME] WebSocket error:', event);
    }

    public on(event: 'data' | 'update', callback: DataCallback | UpdateCallback): void {
        if (event === 'data') this.onDataLoaded = callback as DataCallback;
        else if (event === 'update') this.onUpdate = callback as UpdateCallback;
    }

    public async start(): Promise<void> {
        let cachedKlines = await dbManager.getKlines(this.contractAddress, this.chain, this.interval);
        cachedKlines.sort((a, b) => a.timestamp - b.timestamp);
        if (this.onDataLoaded) {
            this.onDataLoaded(cachedKlines.map(this.mapToLightweightChartKline));
        }

        const lastKline = cachedKlines.length > 0 ? cachedKlines[cachedKlines.length - 1] : null;
        
        // ✨ 核心修改: 根据时间差计算需要的 limit
        let fetchLimit = API_MAX_LIMIT; // 默认全量下载
        let shouldFetch = true;

        if (lastKline) {
            const timeDiff = Date.now() - lastKline.timestamp;
            const intervalMs = intervalToMs(this.interval);
            
            // 向上取整，确保覆盖当前正在形成的 K 线
            const missingCandles = Math.ceil(timeDiff / intervalMs);

            if (missingCandles > API_MAX_LIMIT) {
                console.log(`[CACHE] Data is too old (${missingCandles} missing). Clearing cache and refetching full ${API_MAX_LIMIT}.`);
                await dbManager.clearKlines(this.contractAddress, this.chain, this.interval);
                fetchLimit = API_MAX_LIMIT;
            } else if (missingCandles <= 1) {
                // 如果只差不到1根，通常意味着 WebSocket 会处理，或者刚刚更新过
                // 考虑到网络延迟，我们可以保守地不请求，或者请求 limit=2 以防万一
                // 这里按照需求：如果数据太新，不需要 HTTP 请求，直接依赖 WS
                console.log('[CACHE] Data is up-to-date. No fetch needed.');
                shouldFetch = false;
            } else {
                // 补齐缺失的 K 线，稍微多请求一点点做冗余（覆盖最后那根可能没闭合的）
                fetchLimit = missingCandles; 
                console.log(`[CACHE] Missing approx ${missingCandles} candles. Fetching limit=${fetchLimit}.`);
            }
        }

        if (shouldFetch) {
            const newKlines = await this.fetchHistoricalData(fetchLimit);
            if (newKlines.length > 0) {
                await dbManager.saveKlines(newKlines);
                await dbManager.pruneOldKlines(this.contractAddress, this.chain, this.interval);
                
                // 再次读取并排序
                let allKlines = await dbManager.getKlines(this.contractAddress, this.chain, this.interval);
                allKlines.sort((a, b) => a.timestamp - b.timestamp);
                if (this.onDataLoaded) {
                    this.onDataLoaded(allKlines.map(this.mapToLightweightChartKline));
                }
            }
        }
        
        this.startRealtimeUpdates();
    }

    public stop(): void {
        if (this.ws) {
            const oldWs = this.ws;
            this.ws = null;
            if (oldWs.readyState === WebSocket.OPEN) {
                console.log('🛑 [REALTIME] Closing WebSocket connection.');
                oldWs.close();
            } else {
                console.log(`🛑 [REALTIME] WebSocket is in state ${oldWs.readyState}, abandoning connection.`);
                oldWs.onopen = null;
                oldWs.onmessage = null;
                oldWs.onerror = null;
                oldWs.onclose = null;
            }
        }
    }
}

export default KlineBrowserManager;