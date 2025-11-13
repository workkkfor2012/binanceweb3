// packages/frontend/src/kline-browser-manager.ts
// --- K线数据结构定义 ---
export interface Kline {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number; // K线开始的毫秒级时间戳
    time: number; // lightweight-charts uses seconds
}

// lightweight-charts需要此格式
export interface LightweightChartKline {
    time: number; // UNIX timestamp in seconds
    open: number;
    high: number;
    low: number;
    close: number;
}

const HISTORICAL_API_URL = 'https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval=1min&limit=500&platform={platform}';
const WEBSOCKET_URL = 'wss://nbstream.binance.com/w3w/stream';

type DataCallback = (data: LightweightChartKline[]) => void;
type UpdateCallback = (data: LightweightChartKline) => void;

class KlineBrowserManager {
    private contractAddress: string;
    private chain: string;
    private klineData: Kline[] = [];
    private ws: WebSocket | null = null;

    private onDataLoaded: DataCallback | null = null;
    private onUpdate: UpdateCallback | null = null;

    constructor(contractAddress: string, chain: string) {
        this.contractAddress = contractAddress;
        this.chain = chain.toLowerCase();
        console.log(`📈 KlineManager for ${this.contractAddress} on ${this.chain} initialized.`);
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

    private async fetchHistoricalData(): Promise<void> {
        // ✨ 核心修正: 移除对 'solana' 的错误特殊处理
        // this.chain 在构造函数中已经是小写了 (e.g., 'bsc', 'base', 'solana')
        // 直接使用 this.chain 作为 platform 参数
        const platform = this.chain;

        const url = HISTORICAL_API_URL
            .replace('{address}', this.contractAddress)
            .replace('{platform}', platform);

        console.log(`[HISTORICAL] Fetching from ${url}...`); // 现在会打印正确的 URL
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const json: any = await response.json();

            if (json && Array.isArray(json.data)) {
                this.klineData = json.data.map((d: (string|number)[]): Kline => ({
                    open: parseFloat(String(d[0])),
                    high: parseFloat(String(d[1])),
                    low: parseFloat(String(d[2])),
                    close: parseFloat(String(d[3])),
                    volume: parseFloat(String(d[4])),
                    timestamp: Number(d[5]),
                    time: Number(d[5]) / 1000
                }));
                console.log(`✅ [HISTORICAL] Fetched ${this.klineData.length} candles.`);
            } else {
                console.warn(`[HISTORICAL] No historical data found or invalid API response for ${this.contractAddress}. Response:`, json);
                this.klineData = [];
            }
            
        } catch (error) {
            console.error('❌ [HISTORICAL] Failed to fetch data:', error);
            this.klineData = [];
        }

        if (this.onDataLoaded) {
            this.onDataLoaded(this.klineData.map(this.mapToLightweightChartKline));
        }
    }

    private startRealtimeUpdates(): void {
        this.ws = new WebSocket(WEBSOCKET_URL);

        this.ws.onopen = () => {
            console.log('✅ [REALTIME] WebSocket connected. Subscribing...');
            
            const requestId = `sub-${Date.now()}`;
            
            const subscribeMessage = { 
                id: requestId, 
                method: 'SUBSCRIBE', 
                params: [`kl@14@${this.contractAddress}@1m`] 
            };
            
            this.ws.send(JSON.stringify(subscribeMessage));
            console.log(`[REALTIME] Sent subscription request with ID: ${requestId}`);
        };

        this.ws.onmessage = (event) => {
            const message = JSON.parse(event.data.toString());
            
            if (message.id && message.result === null) {
                console.log(`✅ [REALTIME] Subscription successful for request ID: ${message.id}`);
                return;
            }

            if (message.stream && message.stream.startsWith('kl@')) {
                const tickArray = message.data.d.u;
                const tick: Kline = {
                    open: parseFloat(tickArray[0]),
                    high: parseFloat(tickArray[1]),
                    low: parseFloat(tickArray[2]),
                    close: parseFloat(tickArray[3]),
                    volume: parseFloat(tickArray[4]),
                    timestamp: parseInt(tickArray[5], 10),
                    time: parseInt(tickArray[5], 10) / 1000
                };
                this.processRealtimeTick(tick);
            }
        };

        this.ws.onclose = (event) => {
            console.log(`🔌 [REALTIME] WebSocket closed: code=${event.code}, reason=${event.reason || 'N/A'}. Reconnecting in 5s...`);
            if (this.ws) {
                setTimeout(() => this.startRealtimeUpdates(), 5000);
            }
        };
        
        this.ws.onerror = (event) => {
            console.error('❌ [REALTIME] WebSocket error:', event);
        };
    }

    private processRealtimeTick(tick: Kline): void {
        if (this.klineData.length === 0) {
            this.klineData.push(tick);
            if (this.onUpdate) this.onUpdate(this.mapToLightweightChartKline(tick));
            return;
        }

        const lastCandle = this.klineData[this.klineData.length - 1];

        if (tick.timestamp > lastCandle.timestamp) {
            this.klineData.push(tick);
            if (this.onUpdate) {
                this.onUpdate(this.mapToLightweightChartKline(tick));
            }
        } else if (tick.timestamp === lastCandle.timestamp) {
            Object.assign(lastCandle, tick);
            if (this.onUpdate) {
                this.onUpdate(this.mapToLightweightChartKline(lastCandle));
            }
        }
    }

    public on(event: 'data' | 'update', callback: DataCallback | UpdateCallback): void {
        if (event === 'data') this.onDataLoaded = callback as DataCallback;
        else if (event === 'update') this.onUpdate = callback as UpdateCallback;
    }

    public async start(): Promise<void> {
        await this.fetchHistoricalData();
        this.startRealtimeUpdates();
    }

    public stop(): void {
        if (this.ws) {
            console.log('🛑 [REALTIME] Stopping WebSocket connection.');
            const oldWs = this.ws;
            this.ws = null; 
            oldWs.close();
        }
    }
}

export default KlineBrowserManager;