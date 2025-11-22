// packages/extractor/src/extractor.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
//import { applyVolumeFilter } from './filterManager';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
import type { ExtractedDataPayload } from 'shared-types';
import { DESIRED_FIELDS } from 'shared-types';

chromium.use(stealth());

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
//const MIN_VOLUME_FILTER = 10;
const EXTRACTION_INTERVAL_MS = 1000;
const SERVER_URL = 'http://localhost:3001';

// ✨ 修改：配置中增加 category 字段
// 目前全是 'hotlist'，为你预留了 'new'
const TARGETS = [
    { name: 'BSC', category: 'hotlist', url: 'https://web3.binance.com/zh-CN/markets/trending?chain=bsc' },
    { name: 'Base', category: 'hotlist', url: 'https://web3.binance.com/zh-CN/markets/trending?chain=base' },
    { name: 'Solana', category: 'hotlist', url: 'https://web3.binance.com/zh-CN/markets/trending?chain=sol' },
    // { name: 'BSC_NEW', category: 'new', url: '...' }, // 示例：未来添加的新币榜
];

const SELECTORS = {
    stableContainer: '#__APP div.markets-table',
};

const HEURISTIC_CONFIG = {
    maxFiberTreeDepth: 250,
    minArrayLength: 10,
    requiredKeys: ['symbol', 'price', 'volume24h', 'marketCap', 'priceChange24h'],
};
// ==============================================================================

async function gotoWithRetry(page: Page, url: string, criticalSelector: string, chainName: string, maxRetries: number = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.log(`[Navi][${chainName}] 尝试第 ${attempt}/${maxRetries} 次访问: ${url}`, logger.LOG_LEVELS.INFO);
            await page.goto(url, { waitUntil: 'load', timeout: 90000 });
            await page.waitForSelector(criticalSelector, { state: 'visible', timeout: 45000 });
            logger.log(`[Navi][${chainName}] 页面就绪!`, logger.LOG_LEVELS.INFO);
            return;
        } catch (error: any) {
            logger.log(`[Navi][${chainName}] 第 ${attempt} 次访问失败: ${error.message}`, logger.LOG_LEVELS.ERROR);
            if (attempt === maxRetries) throw error;
            await page.waitForTimeout(5000);
        }
    }
}

/**
 * 封装单个页面的设置和初始化逻辑
 */
async function setupPageForChain(
    browser: Browser,
    browserScript: string,
    target: { name: string; url: string; category: string }, // ✨ 接收 category
    socket: Socket
): Promise<void> {
    const { name: chainName, url, category } = target;
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    logger.log(`[Setup][${chainName}] 初始化页面 (Category: ${category})...`, logger.LOG_LEVELS.INFO);

    const options = {
        selectors: SELECTORS,
        interval: EXTRACTION_INTERVAL_MS,
        desiredFields: DESIRED_FIELDS,
        config: HEURISTIC_CONFIG
    };

    const initScriptContent = `
        (() => {
            ${browserScript}
            window.initializeExtractor(${JSON.stringify(options)});
        })();
    `;

    await page.addInitScript({ content: initScriptContent });
    await page.addInitScript({ content: 'window.originalConsoleLog = console.log;' });

    await gotoWithRetry(page, url, SELECTORS.stableContainer, chainName);

    // 对每个页面独立、健壮地处理弹窗
    await handleGuidePopup(page);
    await checkAndClickCookieBanner(page);
    //await applyVolumeFilter(page, MIN_VOLUME_FILTER);

    const handleExtractedData = (result: ExtractedDataPayload): void => {
        const { type, data, duration, totalCount, changedCount, cacheHit } = result;

        const perfString = `[${chainName.padEnd(6)}] 读取: ${String(totalCount).padEnd(3)} | 变更: ${String(changedCount).padEnd(3)} | 耗时: ${duration}ms | 缓存: ${cacheHit ? '命中' : '未命中'}`;
        process.stdout.write(`\r[${new Date().toLocaleTimeString()}] ${perfString}   `);

        if (type !== 'no-change' && data && data.length > 0) {
            const enrichedData = data.map(item => ({ ...item, chain: chainName }));
            
            const updateTypeLog = type === 'snapshot' ? '首次快照' : '增量更新';
            
            // ✨ 协议重构：发送双字段
            // category: 来自配置 (hotlist, new)
            // type: 来自 browser-script (snapshot, update)
            socket.emit('data-update', { 
                category: category, 
                type: type, 
                data: enrichedData 
            });
            
            // 换行打印，避免和 process.stdout.write 冲突
            process.stdout.write('\n');
            logger.log(`📦 [Emit][${chainName}][${category}] Action: ${type} (${updateTypeLog}, ${changedCount} 条)`, logger.LOG_LEVELS.INFO);
        }
    };

    await page.exposeFunction('onDataExtracted', handleExtractedData);
    logger.log(`✅ [Setup][${chainName}] 页面初始化完成，提取器已注入并运行。`, logger.LOG_LEVELS.INFO);
}


async function main(): Promise<void> {
    logger.init();
    let browser: Browser | undefined;

    const socket: Socket = io(SERVER_URL);
    socket.on('connect', () => logger.log(`✅ [Socket.IO] 成功连接到 Fastify 服务器: ${SERVER_URL}`, logger.LOG_LEVELS.INFO));
    socket.on('connect_error', (err: Error) => logger.log(`❌ [Socket.IO] 连接失败: ${err.message}.`, logger.LOG_LEVELS.ERROR));

    logger.log('🚀 [Extractor v6.3 Categories] 脚本启动...', logger.LOG_LEVELS.INFO);

    try {
        const browserScript = await fs.readFile(path.join(__dirname, '..', 'src', 'browser-script.js'), 'utf-8');

        browser = await chromium.launch({
            executablePath: MY_CHROME_PATH,
            headless: true,
            proxy: { server: 'socks5://127.0.0.1:1080' },
            args: ['--start-maximized']
        });

        // 并行初始化所有目标页面
        const setupPromises = TARGETS.map(target =>
            setupPageForChain(browser!, browserScript, target, socket)
        );
        await Promise.all(setupPromises);

        logger.log(`\n👍 所有 [${TARGETS.length}] 个页面均已初始化完毕，脚本进入高频变更检测模式。`, logger.LOG_LEVELS.INFO);
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