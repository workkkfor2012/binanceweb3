// packages/extractor/src/extractor.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium, Browser } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
import { applyVolumeFilter } from './filterManager';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
import type { ExtractedDataPayload } from 'shared-types';

chromium.use(stealth());

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 1;
const EXTRACTION_INTERVAL_MS = 1000;
const SERVER_URL = 'http://localhost:3001';

const SELECTORS = {
    stableContainer: '#__APP div.markets-table',
};

const HEURISTIC_CONFIG = {
    maxFiberTreeDepth: 250,
    minArrayLength: 10,
    requiredKeys: ['symbol', 'price', 'volume24h', 'marketCap', 'priceChange24h'],
};

const DESIRED_FIELDS = [
    'chainId', 'contractAddress', 'symbol', 'icon',
    'marketCap', 'price',
    'volume1m', 'volume5m', 'volume1h', 'volume4h', 'volume24h',
    'priceChange1m', 'priceChange5m', 'priceChange1h', 'priceChange4h', 'priceChange24h'
];
// ==============================================================================

async function main(): Promise<void> {
    logger.init();
    let browser: Browser | undefined;

    const socket: Socket = io(SERVER_URL);
    socket.on('connect', () => {
        logger.log(`✅ [Socket.IO] 成功连接到 Fastify 服务器: ${SERVER_URL}`, logger.LOG_LEVELS.INFO);
    });
    socket.on('connect_error', (err: Error) => {
        logger.log(`❌ [Socket.IO] 连接失败: ${err.message}. 请确认后端服务 (npm run dev:backend) 已运行.`, logger.LOG_LEVELS.ERROR);
    });

    logger.log('🚀 [Extractor v5.0 TS] 脚本启动...', logger.LOG_LEVELS.INFO);

    try {
        // 关键：当此脚本被编译并从 dist/ 目录运行时, __dirname 会指向 dist/
        // 因此它会正确地读取一同被编译到 dist/ 的 browser-script.js
        const browserScript = await fs.readFile(path.join(__dirname, 'browser-script.js'), 'utf-8');

        browser = await chromium.launch({
            executablePath: MY_CHROME_PATH,
            headless: false,
            proxy: { server: 'socks5://127.0.0.1:1080' },
            args: ['--start-maximized']
        });

        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();

        await page.addInitScript({
            content: 'window.originalConsoleLog = console.log;'
        });

        await page.goto('https://web3.binance.com/zh-CN/markets/trending?chain=bsc', { waitUntil: 'load', timeout: 90000 });
        await handleGuidePopup(page);
        await checkAndClickCookieBanner(page);
        await applyVolumeFilter(page, MIN_VOLUME_FILTER);

        logger.log('✅ 页面初始化完成，准备注入智能提取器...', logger.LOG_LEVELS.INFO);

        const handleExtractedData = (result: ExtractedDataPayload): void => {
            const {
                type, data,
                duration, readDuration, diffDuration,
                totalCount, changedCount, cacheHit
            } = result;

            const cacheStatus = cacheHit ? '命中缓存' : '未命中';
            const timeStamp = `[${new Date().toLocaleTimeString()}]`;

            const perfString = `读取: ${totalCount} | 变更: ${changedCount} | 总耗时: ${duration}ms (读取: ${readDuration}ms, Diff: ${diffDuration}ms) | ${cacheStatus}`;
            process.stdout.write(`\r${timeStamp} Tick. [性能: ${perfString}]      `);

            if (type !== 'no-change' && data && data.length > 0) {
                const updateType = type === 'snapshot' ? '首次快照' : '增量更新';
                logger.log(`\n📦 [数据发送] 正在发送 "${updateType}" (${changedCount} 条) 到 Fastify 服务器...`, logger.LOG_LEVELS.INFO);

                socket.emit('data-update', { type, data });
            }
        };
        await page.exposeFunction('onDataExtracted', handleExtractedData);

        await page.evaluate(`
          ${browserScript}
          initializeExtractor(${JSON.stringify({
            selectors: SELECTORS,
            interval: EXTRACTION_INTERVAL_MS,
            desiredFields: DESIRED_FIELDS,
            config: HEURISTIC_CONFIG
        })});
        `);

        logger.log(`\n👍 脚本进入高频变更检测模式 (${EXTRACTION_INTERVAL_MS}ms)。`, logger.LOG_LEVELS.INFO);
        await new Promise(() => { });

    } catch (error: any) {
        logger.log(`❌ 脚本执行时发生严重错误: ${error.stack}`, logger.LOG_LEVELS.ERROR);
    } finally {
        socket.disconnect();
        if (browser) {
            logger.log('\n🏁 脚本结束，关闭浏览器.', logger.LOG_LEVELS.INFO);
            await browser.close();
        }
        logger.close();
    }
}

main();