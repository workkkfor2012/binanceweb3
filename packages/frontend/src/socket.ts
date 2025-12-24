// packages/frontend/src/socket.ts
import { io, Socket } from 'socket.io-client';

const CORE_BACKEND_URL = 'https://115.190.227.163:30001';
const MARKET_BACKEND_URL = 'http://localhost:30003';

// 云端核心 Socket (Hotlist, Meme, 报警)
export const coreSocket: Socket = io(CORE_BACKEND_URL, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5
});

// 本地行情 Socket (K线, 实时成交)
export const marketSocket: Socket = io(MARKET_BACKEND_URL, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5
});

coreSocket.on('connect', () => {
    console.log(`[CoreSocket] Connected with id: ${coreSocket.id}`);
});

marketSocket.on('connect', () => {
    console.log(`[MarketSocket] Connected with id: ${marketSocket.id}`);
});

marketSocket.on('connect_error', (err: any) => {
    console.warn(`[MarketSocket] Connection failed (Is local backend running?):`, err.message);
});