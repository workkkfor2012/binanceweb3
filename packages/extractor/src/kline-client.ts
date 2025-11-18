// packages/extractor/src/kline-client.ts
import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

// --- 全局配置 ---
const WEBSOCKET_URL = 'wss://nbstream.binance.com/w3w/stream';
const PROXY_URL = 'socks5://127.0.0.1:1080';

const requestHeaders = {
    "Origin": "https://web3.binance.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
};

const agent = new SocksProxyAgent(PROXY_URL);

// --- 链特有的配置中心 ---
type Chain = 'bsc' | 'sol' | 'base';

const CHAIN_CONFIG: Record<Chain, { internalPoolId: number }> = {
    bsc: { internalPoolId: 14 },
    sol: { internalPoolId: 16 },
    base: { internalPoolId: 199 } // ✨ 新增 Base 链的配置
};

// --- 🚀 订阅清单: 在这里定义所有你想订阅的资产 ---
const TARGETS_TO_SUBSCRIBE: { chain: Chain; contractAddress: string; interval: string }[] = [
    //{ chain: 'bsc',  contractAddress: '0xea37a8de1de2d9d10772eeb569e28bfa5cb17707', interval: '1m' },
    { chain: 'sol',  contractAddress: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', interval: '1m' },
    //{ chain: 'base', contractAddress: '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', interval: '1m' },
];

/**
 * 多链K-line订阅客户端
 * 管理一个单一的WebSocket连接，并处理所有目标的订阅和数据接收。
 */
function MultiChainKlineClient() {
    function connect() {
        console.log(`[MANAGER] Connecting to ${WEBSOCKET_URL} via proxy...`);
        const ws = new WebSocket(WEBSOCKET_URL, { headers: requestHeaders, agent: agent });

        ws.on('open', () => {
            console.log('✅ [MANAGER] Connection successful. Subscribing to all targets...');
            
            TARGETS_TO_SUBSCRIBE.forEach(target => {
                const config = CHAIN_CONFIG[target.chain];
                if (!config) {
                    console.error(`❌ [ERROR] Missing config for chain: '${target.chain}'. Skipping subscription.`);
                    return;
                }
                
                const subscriptionParam = `kl@${config.internalPoolId}@${target.contractAddress}@${target.interval}`;
                const subscribeMessage = {
                    id: `${target.chain}-kl-${Date.now()}`,
                    method: 'SUBSCRIBE',
                    params: [subscriptionParam]
                };

                ws.send(JSON.stringify(subscribeMessage));
                console.log(`  -> Sent subscription for ${target.chain.toUpperCase()}: ${target.contractAddress}`);
            });

            console.log('------------------- ALL SUBSCRIPTIONS SENT, WAITING FOR DATA -------------------');
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                if (message.stream && message.stream.startsWith('kl@')) {
                    // 从 stream 字段中提取关键信息用于日志
                    const [, poolId, address] = message.stream.split('@');
                    const chain = Object.keys(CHAIN_CONFIG).find(
                        key => CHAIN_CONFIG[key as Chain].internalPoolId == poolId
                    ) || 'UNKNOWN';

                    console.log(`\n--- [${new Date().toLocaleTimeString()}] [${chain.toUpperCase()}] KLINE UPDATE for ${address} ---`);
                    console.log(JSON.stringify(message.data, null, 2));

                } else if (message.id) {
                    console.log(`[RESPONSE] Received for ID ${message.id}: ${JSON.stringify(message.result)}`);
                } else {
                    console.log(`[UNHANDLED MESSAGE] Received: ${JSON.stringify(message)}`);
                }
                
            } catch (error) {
                console.error('\n❌ Failed to parse message:', error);
                console.log('Raw Data:', data.toString());
            }
        });

        ws.on('close', (code, reason) => {
            console.log(`\n🔌 [MANAGER] Connection closed: code=${code}, reason=${reason.toString()}`);
            console.log('   Reconnecting in 5s...');
            setTimeout(connect, 5000);
        });

        ws.on('error', (err) => {
            console.error('\n❌ [MANAGER] WebSocket Error:', err.message);
        });
    }

    console.log("🚀 Starting Multi-Chain K-Line Client...");
    connect();
}

// 启动客户端
MultiChainKlineClient();