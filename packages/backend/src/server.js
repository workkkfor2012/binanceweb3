// packages/backend/src/server.js
const fastify = require('fastify')({ logger: true });
const { Server } = require('socket.io');

// ✨ 核心：我们只需要 undici 库自带的 request 和 ProxyAgent
const { request: fetch, ProxyAgent } = require('undici');

const PORT = 3001;
const imageCache = new Map();

// ✨ 核心：使用 undici 自带的 ProxyAgent，并指定 HTTP 协议
// ！！！请务必确认你的 HTTP 代理端口并在这里修改 ！！！
const proxyAgent = new ProxyAgent('http://127.0.0.1:1080'); 

fastify.register(require('@fastify/cors'), {
  origin: "http://localhost:15173",
  methods: ["GET", "POST"],
});

fastify.get('/image-proxy', async (request, reply) => {
  const imageUrl = request.query.url;

  if (!imageUrl) {
    return reply.code(400).send('Missing url query parameter');
  }

  if (imageCache.has(imageUrl)) {
    fastify.log.info(`[CACHE HIT] Serving image from cache: ${imageUrl}`);
    const { buffer, headers } = imageCache.get(imageUrl);
    return reply.headers(headers).send(buffer);
  }

  try {
    fastify.log.info(`[CACHE MISS] Fetching image via HTTP proxy: ${imageUrl}`);
    
    // ✨ 核心：这个 dispatcher 完全兼容 undici，并且指向了正确的 HTTP 代理
    const response = await fetch(imageUrl, {
      dispatcher: proxyAgent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' }
    });

    if (response.statusCode !== 200) {
      return reply.code(response.statusCode).send(`Failed to fetch image, status: ${response.statusCode}`);
    }

    const imageBuffer = Buffer.from(await response.body.arrayBuffer());
    
    const relevantHeaders = {
      'content-type': response.headers['content-type'],
      'content-length': imageBuffer.length,
      'cache-control': response.headers['cache-control'] || 'public, max-age=86400', 
    };

    imageCache.set(imageUrl, {
      buffer: imageBuffer,
      headers: relevantHeaders,
    });

    return reply.headers(relevantHeaders).send(imageBuffer);

  } catch (err) {
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

io.on('connection', (socket) => {
  fastify.log.info(`[Socket.IO] Client connected: ${socket.id}`);
  socket.on('data-update', (payload) => {
    io.emit('data-broadcast', payload);
  });
  socket.on('disconnect', () => {
    fastify.log.info(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

const start = async () => {
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