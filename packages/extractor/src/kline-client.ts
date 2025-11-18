// packages/extractor/src/kline-client.ts
import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { URL } from 'url';

// --- 全局配置 ---
const WEBSOCKET_URL = 'wss://nbstream.binance.com/w3w/stream';
const PROXY_URL = 'socks5://127.0.0.1:1080'; // 如果不需要代理，请设为 null 或 undefined
const RECONNECT_DELAY_MS = 5000;

// --- 链特有的配置中心 ---
type Chain = 'bsc' | 'sol' | 'base';

const CHAIN_CONFIG: Record<Chain, { internalPoolId: number }> = {
    bsc: { internalPoolId: 14 },
    sol: { internalPoolId: 16 },
    base: { internalPoolId: 199 }
};

// --- 🚀 订阅清单: 在这里定义所有你想订阅的资产 ---
const TARGETS_TO_SUBSCRIBE: { chain: Chain; contractAddress: string; interval: string }[] = [
    //{ chain: 'bsc',  contractAddress: '0xea37a8de1de2d9d10772eeb569e28bfa5cb17707', interval: '1m' },
    { chain: 'sol',  contractAddress: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', interval: '1m' },
    //{ chain: 'base', contractAddress: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', interval: '1m' },
];

/**
 * 多链 K-line 与 Tick 数据订阅客户端
 * 负责管理一个到 Binance Web3 的 WebSocket 连接，处理订阅、数据接收和自动重连。
 */
class MultiStreamClient {
    private ws: WebSocket | null = null;
    private agent: SocksProxyAgent | undefined;

    constructor() {
        if (PROXY_URL) {
            this.agent = new SocksProxyAgent(PROXY_URL);
            console.log(`[CONFIG] Using SOCKS5 proxy: ${PROXY_URL}`);
        } else {
            console.log(`[CONFIG] No proxy configured.`);
        }
        console.log("🚀 Initializing Multi-Chain K-Line & Tick Client...");
    }

    public start(): void {
        this.connect();
    }
    
    private connect(): void {
        console.log(`[MANAGER] Attempting to connect to ${WEBSOCKET_URL}...`);
        
        const headers = {
            'Host': new URL(WEBSOCKET_URL).host,
            'Connection': 'Upgrade',
            'Pragma': 'no-cache',
            'Cache-Control': 'no-cache',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            'Upgrade': 'websocket',
            'Origin': 'https://web3.binance.com',
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        };

        const wsOptions: WebSocket.ClientOptions = {
            headers,
            agent: this.agent,
            perMessageDeflate: {
                clientNoContextTakeover: true,
                serverNoContextTakeover: true,
                clientMaxWindowBits: 15,
                serverMaxWindowBits: 15,
                zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
                zlibInflateOptions: { chunkSize: 10 * 1024 },
            }
        };

        this.ws = new WebSocket(WEBSOCKET_URL, wsOptions);

        this.ws.on('open', this.onOpen.bind(this));
        this.ws.on('message', this.onMessage.bind(this));
        this.ws.on('close', this.onClose.bind(this));
        this.ws.on('error', this.onError.bind(this));
    }

    private onOpen(): void {
        console.log('✅ [MANAGER] Connection successful. Subscribing to all targets...');
        this.subscribeToAll();
        console.log('------------------- ALL SUBSCRIPTIONS SENT, WAITING FOR DATA -------------------');
    }

    private subscribeToAll(): void {
        TARGETS_TO_SUBSCRIBE.forEach(target => {
            const config = CHAIN_CONFIG[target.chain];
            if (!config) {
                console.error(`❌ [ERROR] Missing config for chain: '${target.chain}'. Skipping subscription.`);
                return;
            }
            
            const klineParam = `kl@${config.internalPoolId}@${target.contractAddress}@${target.interval}`;
            this.sendSubscription('sub-kl', target.chain, klineParam);
            
            const tickParam = `tx@${config.internalPoolId}_${target.contractAddress}`;
            this.sendSubscription('sub-tx', target.chain, tickParam);
        });
    }

    private sendSubscription(prefix: string, chain: string, param: string): void {
        if (!this.ws) return;

        const subscribeMessage = {
            id: `${prefix}-${chain}-${Math.random().toString(36).substring(2, 9)}`,
            method: 'SUBSCRIBE',
            params: [param]
        };
        this.ws.send(JSON.stringify(subscribeMessage));
        console.log(`  -> Sent subscription for ${chain.toUpperCase()}: param: ${param}`);
    }

    private onMessage(data: WebSocket.RawData): void {
        try {
            const message = JSON.parse(data.toString('utf-8'));
            
            if (message.stream) {
                this.handleStreamData(message);
            } else if (message.id) {
                console.log(`[RESPONSE] Received for ID ${message.id}: ${JSON.stringify(message.result ?? message.error)}`);
            } else {
                // console.log(`[UNHANDLED MESSAGE] Received: ${JSON.stringify(message)}`);
            }
            
        } catch (error) {
            console.error('\n❌ Failed to parse message:', error);
            console.log('Raw Data:', data.toString('utf-8'));
        }
    }

    /**
     * 核心数据流处理函数，现在输出格式化的单行日志
     * @param message 包含 stream 和 data 字段的已解析消息
     */
    private handleStreamData(message: { stream: string, data: any }): void {
        const stream = message.stream;
        let streamType: 'KLINE' | 'TICK' | 'UNKNOWN' = 'UNKNOWN';
        //let parts: string[];
        let poolId: string = '';
        
        // --- 解析 Stream 以确定类型和 Pool ID ---
        if (stream.startsWith('kl@')) {
            streamType = 'KLINE';
            [, poolId] = stream.split('@');
        } else if (stream.startsWith('tx@')) {
            streamType = 'TICK';
            const poolIdAndAddress = stream.split('@')[1];
            [poolId] = poolIdAndAddress.split('_');
        } else {
            console.log(`[UNHANDLED STREAM] Received data on unknown stream: ${stream}`);
            return;
        }

        const chain = Object.keys(CHAIN_CONFIG).find(
            key => CHAIN_CONFIG[key as Chain].internalPoolId === Number(poolId)
        ) || 'UNKNOWN_CHAIN';
        
        const time = new Date().toLocaleTimeString();

        // --- 根据类型格式化输出 ---
        if (streamType === 'KLINE') {
            const [o, h, l, c, v, t] = message.data.d.u;
            const klineTime = new Date(parseInt(t, 10)).toLocaleString();
            console.log(
                `[${time}] [${chain.toUpperCase()}] \x1b[36mKLINE BAR\x1b[0m | ` + // Cyan color for KLINE
                `O: ${parseFloat(o).toFixed(4)} H: ${parseFloat(h).toFixed(4)} ` +
                `L: ${parseFloat(l).toFixed(4)} C: ${parseFloat(c).toFixed(4)} ` +
                `V: ${parseFloat(v).toFixed(2)} | Time: ${klineTime}`
            );
        } else if (streamType === 'TICK') {
            const tick = message.data.d;
            const price = parseFloat(tick.t0pu);
            const amountUSD = parseFloat(tick.v);
            const side = tick.tp.toUpperCase();
            
            // 使用ANSI转义码为买卖方向添加颜色
            const sideColor = side === 'BUY' ? '\x1b[32m' : '\x1b[31m'; // Green for BUY, Red for SELL
            const resetColor = '\x1b[0m';

            console.log(
                `[${time}] [${chain.toUpperCase()}] TICK      | ` +
                `Side: ${sideColor}${side.padEnd(4)}${resetColor} | ` +
                `Price: \x1b[33m${price.toFixed(4).padStart(9)}\x1b[0m USD | ` + // Yellow for Price
                `Amount: ${amountUSD.toFixed(2).padStart(8)} USD`
            );
        }
    }

    private onClose(code: number, reason: Buffer): void {
        console.log(`\n🔌 [MANAGER] Connection closed: code=${code}, reason=${reason.toString()}`);
        this.ws = null;
        this.reconnect();
    }

    private onError(err: Error): void {
        console.error('\n❌ [MANAGER] WebSocket Error:', err.message);
    }
    
    private reconnect(): void {
        console.log(`   Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    }
}

// --- 启动客户端 ---
const client = new MultiStreamClient();
client.start();