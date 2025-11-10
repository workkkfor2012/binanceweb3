// packages/extractor/src/kline-client.ts
import WebSocket from 'ws';
import { SocksProxyAgent } from 'socks-proxy-agent';

const WEBSOCKET_URL = 'wss://nbstream.binance.com/w3w/stream';
const PROXY_URL = 'socks5://127.0.0.1:1080';

// --- 参数定义 ---
// ✨ --- 核心修复 1: 使用完整的地址，并确保它会被使用 --- ✨
const contractAddress = '0xea37a8de1de2d9d10772eeb569e28bfa5cb17707'; 
const internalPoolId = 14;
const klineInterval = '1m';

// ✨ --- 核心修复 2: 使用上面定义的 contractAddress 常量 --- ✨
const minimalSubscriptionParams = [
    `kl@${internalPoolId}@${contractAddress}@${klineInterval}`
];

const requestHeaders = {
    "Origin": "http://localhost:15173",
    //"Origin": "https://web3.binance.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
};

const agent = new SocksProxyAgent(PROXY_URL);

function connect() {
    console.log(`[RAW DATA OBSERVER] Connecting via proxy: ${PROXY_URL}...`);
    
    const ws = new WebSocket(WEBSOCKET_URL, { 
        headers: requestHeaders, 
        agent: agent 
    });

    ws.on('open', () => {
        console.log('✅ Connection successful. Subscribing to K-line stream...');
        const subscribeMessage = { id: `raw-obs-${Date.now()}`, method: 'SUBSCRIBE', params: minimalSubscriptionParams };
        ws.send(JSON.stringify(subscribeMessage));
        console.log('------------------- WAITING FOR K-LINE DATA -------------------');
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.stream && message.stream.startsWith('kl@')) {
                console.log(`\n--- [${new Date().toLocaleTimeString()}.${String(new Date().getMilliseconds()).padStart(3, '0')}] KLINE MESSAGE RECEIVED ---`);
                console.log(JSON.stringify(message, null, 2));
            } else if (message.id) {
                console.log(`[RESPONSE] Received: ${JSON.stringify(message)}`);
            }
            
        } catch (error) {
            console.error('\n❌ Failed to parse message:', error);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`\n🔌 Connection closed: code=${code}, reason=${reason.toString()}`);
        console.log('   Reconnecting in 3s...');
        setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.error('\n❌ WebSocket Error:', err.message);
    });
}

console.log("🚀 Starting K-Line Raw Data Observer...");
connect();