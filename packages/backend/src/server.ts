// packages/backend/src/server.ts
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { Server, Socket } from 'socket.io';
import cors from '@fastify/cors';
import { request as fetch, ProxyAgent } from 'undici';
import { Buffer } from 'buffer';
// 从共享包导入类型!
import type { MarketItem, DataPayload } from 'shared-types';

// --- 类型定义 ---
// 图片缓存的条目结构
interface CacheEntry {
  buffer: Buffer;
  headers: Record<string, string | number | string[] | undefined>;
}

// 图像代理的查询参数
interface ImageProxyQuery {
  url: string;
}

// --- 服务实现 ---
const fastify = Fastify({ logger: true });
const PORT = 3001;
const imageCache = new Map<string, CacheEntry>();

const proxyAgent = new ProxyAgent('http://127.0.0.1:1080');

fastify.register(cors, {
  origin: "http://localhost:15173",
  methods: ["GET", "POST"],
});

fastify.get('/image-proxy', async (
  request: FastifyRequest<{ Querystring: ImageProxyQuery }>,
  reply: FastifyReply
) => {
  const { url: imageUrl } = request.query;

  if (!imageUrl) {
    return reply.code(400).send('Missing url query parameter');
  }

  if (imageCache.has(imageUrl)) {
    fastify.log.info(`[CACHE HIT] Serving image from cache: ${imageUrl}`);
    const { buffer, headers } = imageCache.get(imageUrl)!;
    return reply.headers(headers).send(buffer);
  }

  try {
    fastify.log.info(`[CACHE MISS] Fetching image via HTTP proxy: ${imageUrl}`);

    const response = await fetch(imageUrl, {
      dispatcher: proxyAgent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' }
    });

    if (response.statusCode !== 200) {
      return reply.code(response.statusCode ?? 500).send(`Failed to fetch image, status: ${response.statusCode}`);
    }

    const imageBuffer = Buffer.from(await response.body.arrayBuffer());

    const relevantHeaders: Record<string, any> = {
      'content-type': response.headers['content-type'],
      'content-length': imageBuffer.length,
      'cache-control': response.headers['cache-control'] || 'public, max-age=86400',
    };

    imageCache.set(imageUrl, {
      buffer: imageBuffer,
      headers: relevantHeaders,
    });

    return reply.headers(relevantHeaders).send(imageBuffer);

  } catch (err: any) {
    fastify.log.error(`[PROXY ERROR] Failed to fetch image ${imageUrl}: ${err.message}`);
    return reply.code(500).send('Error fetching image');
  }
});

const io = new Server(fastify.server, {
  cors: {
    origin: "http://localhost:15173",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket: Socket) => {
  fastify.log.info(`[Socket.IO] Client connected: ${socket.id}`);

  socket.on('data-update', (payload: DataPayload) => {
    // 广播给所有客户端
    io.emit('data-broadcast', payload);
  });

  socket.on('disconnect', () => {
    fastify.log.info(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

const start = async (): Promise<void> => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`🚀 Fastify server is running at http://localhost:${PORT}`);
    fastify.log.info('Waiting for clients to connect...');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();