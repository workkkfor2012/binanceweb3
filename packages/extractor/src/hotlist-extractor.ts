// packages/extractor/src/extractor.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
import { applyPriceChangeSort } from './filterManager';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
// 引入类型
import type { ExtractedDataPayload, HotlistItem } from 'shared-types';
import { DESIRED_FIELDS } from 'shared-types';

chromium.use(stealth());

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXTRACTION_INTERVAL_MS = 500;
const SERVER_URL = 'http://localhost:3001';

// ✨ 配置分类：全是 hotlist
const TARGETS = [
    { name: 'BSC', category: 'hotlist', url: 'https://web3.binance.com/zh-CN/markets/trending?chain=bsc' },
    // { name: 'Base', category: 'hotlist', url: 'https://web3.binance.com/zh-CN/markets/trending?chain=base' },
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

async function setupPageForChain(
    browser: Browser,
    browserScript: string,
    target: { name: string; url: string; category: string },
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
    await handleGuidePopup(page);
    await checkAndClickCookieBanner(page);
    await page.waitForTimeout(3000);
    // 热门榜按涨跌幅排序
    await applyPriceChangeSort(page);

    // ✨ 数据处理回调：将 Raw Item (any) 转换为 HotlistItem
    const handleExtractedData = (result: ExtractedDataPayload): void => {
        const { type, data, duration, totalCount, cacheHit } = result;

        const perfString = `[${chainName.padEnd(6)}] 读取: ${String(totalCount).padEnd(3)} | 耗时: ${duration}ms | 缓存: ${cacheHit ? '命中' : '未命中'}`;
        process.stdout.write(`\r[${new Date().toLocaleTimeString()}] ${perfString}   `);

        if (type !== 'no-change' && data && data.length > 0) {
            
            // 映射到 Shared Types 的 HotlistItem
            const enrichedData: HotlistItem[] = data.map((item: any) => ({
                // --- BaseItem ---
                chain: chainName,
                contractAddress: item.contractAddress,
                symbol: item.symbol,
                icon: item.icon,
                updateTime: Date.now(),
                
                // --- HotlistItem 特有 ---
                price: parseFloat(item.price) || 0,
                marketCap: parseFloat(item.marketCap) || 0,
                volume1h: parseFloat(item.volume1h) || 0,
                volume24h: parseFloat(item.volume24h) || 0,
                priceChange1h: parseFloat(item.priceChange1h) || 0,
                priceChange24h: parseFloat(item.priceChange24h) || 0,
                volume5m: parseFloat(item.volume5m) || 0,
                priceChange5m: parseFloat(item.priceChange5m) || 0,
                
                source: 'hotlist'
            }));

            // 发送 Payload，Category 必须是 'hotlist'
            socket.emit('data-update', { 
                category: category, // 这里的 category 应该是 'hotlist'
                type: type, 
                data: enrichedData 
            });
        }
    };

    await page.exposeFunction('onDataExtracted', handleExtractedData);
    logger.log(`✅ [Setup][${chainName}] 页面初始化完成，提取器已注入并运行。`, logger.LOG_LEVELS.INFO);
}


async function main(): Promise<void> {
    logger.init();
    let browser: Browser | undefined;
    const socket: Socket = io(SERVER_URL);

    socket.on('connect', () => logger.log(`✅ [Socket.IO] 成功连接到服务器: ${SERVER_URL}`, logger.LOG_LEVELS.INFO));
    socket.on('connect_error', (err: Error) => logger.log(`❌ [Socket.IO] 连接失败: ${err.message}.`, logger.LOG_LEVELS.ERROR));

    logger.log('🚀 [HotlistExtractor] 脚本启动...', logger.LOG_LEVELS.INFO);

    try {
        const browserScript = await fs.readFile(path.join(__dirname, '..', 'src', 'browser-script.js'), 'utf-8');

        browser = await chromium.launch({
            executablePath: MY_CHROME_PATH,
            headless: true,
            proxy: { server: 'socks5://127.0.0.1:1080' },
            args: ['--start-maximized']
        });

        const setupPromises = TARGETS.map(target =>
            setupPageForChain(browser!, browserScript, target, socket)
        );
        await Promise.all(setupPromises);

        logger.log(`\n👍 所有 [${TARGETS.length}] 个页面初始化完毕。`, logger.LOG_LEVELS.INFO);
        await new Promise(() => { });

    } catch (error: any) {
        logger.log(`❌ 脚本执行时发生严重错误: ${error.stack}`, logger.LOG_LEVELS.ERROR);
    } finally {
        socket.disconnect();
        if (browser) await browser.close();
        logger.close();
    }
}

main();