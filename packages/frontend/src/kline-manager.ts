// packages/extractor/src/kline-manager.ts
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

// --- 配置区 ---
const HISTORICAL_API_URL = 'https://dquery.sintral.io/u-kline/v1/k-line/candles?address={address}&interval=1min&limit=500&platform=bsc';
const WEBSOCKET_URL = 'wss://nbstream.binance.com/w3w/stream';
const PROXY_URL = 'socks5://127.0.0.1:1080';
const CONTRACT_ADDRESS = '0xea37a8de1de2d9d10772eeb569e28bfa5cb17707';

// --- K线数据结构定义 ---
interface Kline {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: number; // K线开始的毫秒级时间戳
}

class KlineManager {
    private contractAddress: string;
    private klineData: Kline[] = [];
    private agent: SocksProxyAgent;
    private ws: WebSocket | null = null;

    constructor(contractAddress: string) {
        this.contractAddress = contractAddress;
        this.agent = new SocksProxyAgent(PROXY_URL);
        console.log(`📈 KlineManager for ${contractAddress} initialized.`);
    }

    private async fetchHistoricalData(): Promise<void> {
        const url = HISTORICAL_API_URL.replace('{address}', this.contractAddress);
        console.log(`[HISTORICAL] Fetching from ${url}...`);
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const json: any = await response.json();
            
            this.klineData = json.data.map((d: (string|number)[]): Kline => ({
                open: parseFloat(String(d[0])),
                high: parseFloat(String(d[1])),
                low: parseFloat(String(d[2])),
                close: parseFloat(String(d[3])),
                volume: parseFloat(String(d[4])),
                timestamp: Number(d[5]),
            }));
            console.log(`✅ [HISTORICAL] Fetched ${this.klineData.length} candles. Latest: ${new Date(this.klineData[this.klineData.length - 1].timestamp).toLocaleString()}`);
        } catch (error) {
            console.error('❌ [HISTORICAL] Failed to fetch data:', error);
        }
    }

    private startRealtimeUpdates(): void {
        const requestHeaders = { "Origin": "https://web3.binance.com", "User-Agent": "Mozilla/5.0" };
        this.ws = new WebSocket(WEBSOCKET_URL, { headers: requestHeaders, agent: this.agent });

        this.ws.on('open', () => {
            console.log('✅ [REALTIME] WebSocket connected. Subscribing...');
            const subscribeMessage = { id: `km-${this.contractAddress}`, method: 'SUBSCRIBE', params: [`kl@14@${this.contractAddress}@1m`] };
            this.ws.send(JSON.stringify(subscribeMessage));
        });

        this.ws.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.stream && message.stream.startsWith('kl@')) {
                const tickArray = message.data.d.u;
                const tick: Kline = {
                    open: parseFloat(tickArray[0]),
                    high: parseFloat(tickArray[1]),
                    low: parseFloat(tickArray[2]),
                    close: parseFloat(tickArray[3]),
                    volume: parseFloat(tickArray[4]),
                    timestamp: parseInt(tickArray[5], 10),
                };
                this.processRealtimeTick(tick);
            }
        });

        this.ws.on('close', () => setTimeout(() => this.startRealtimeUpdates(), 5000));
        this.ws.on('error', (err) => console.error('❌ [REALTIME] WebSocket error:', err.message));
    }

    // ✨ --- 最终版、100%可靠的核心合并逻辑 --- ✨
    private processRealtimeTick(tick: Kline): void {
        if (this.klineData.length === 0) {
            this.klineData.push(tick);
            return;
        }

        const lastCandle = this.klineData[this.klineData.length - 1];

        if (tick.timestamp > lastCandle.timestamp) {
            // 新的K线开始了
            console.log(`\n🕯️  New Candle Detected! Time: ${new Date(tick.timestamp).toLocaleString()}`);
            this.klineData.push(tick);
        } else if (tick.timestamp === lastCandle.timestamp) {
            // 更新当前K线
            lastCandle.high = tick.high; // 实时数据已经是OHLC，直接覆盖即可
            lastCandle.low = tick.low;
            lastCandle.close = tick.close;
            lastCandle.volume = tick.volume;
        }
        // 如果 tick.timestamp < lastCandle.timestamp，忽略这个迟到的数据包

        const latest = this.klineData[this.klineData.length - 1];
        process.stdout.write(`\r📊 Total Candles: ${this.klineData.length} | Last Close: ${latest.close.toFixed(6)} | Vol: ${latest.volume.toFixed(2)} [${new Date(latest.timestamp).toLocaleTimeString()}]`);
    }

    public async start(): Promise<void> {
        await this.fetchHistoricalData();
        this.startRealtimeUpdates();
    }
}

// --- 启动管理器 ---
const manager = new KlineManager(CONTRACT_ADDRESS);
manager.start();