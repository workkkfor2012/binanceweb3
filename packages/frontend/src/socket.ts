// packages/frontend/src/socket.ts
import { io, Socket } from 'socket.io-client';

const BACKEND_URL = 'http://localhost:3001';

// 创建并导出一个单例的 socket 实例
export const socket: Socket = io(BACKEND_URL, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5
});

socket.on('connect', () => {
    console.log(`[Socket] Connected to backend server with id: ${socket.id}`);
});

socket.on('disconnect', (reason) => {
    console.warn(`[Socket] Disconnected from backend server: ${reason}`);
});