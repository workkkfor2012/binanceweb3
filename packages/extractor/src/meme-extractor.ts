// packages/extractor/src/meme-extractor.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
import type { ExtractedDataPayload } from 'shared-types';

chromium.use(stealth());

// ==============================================================================
// --- ⚙️ Meme Rush 生产配置 ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SERVER_URL = 'http://localhost:3001';
const EXTRACTION_INTERVAL_MS = 500;

const TARGET = {
    name: 'BSC_MEME',
    url: 'https://web3.binance.com/zh-CN/meme-rush?chain=bsc',
    category: 'meme_new' 
};

const MEME_CONFIG = {
    heuristic: {
        maxFiberTreeDepth: 100, 
        minArrayLength: 2, 
        requiredKeys: ['symbol', 'contractAddress'], 
    },
    // 这里还是需要的，否则 browser-script.js 里的过滤逻辑会报错
    desiredFields: [
        'contractAddress', 'symbol', 'name', 'marketCap', 'liquidity',      
        'volume', 'progress', 'holders', 'createTime', 'twitter', 
        'telegram', 'website', 'icon',
    ]
};
// ==============================================================================

async function detectStableContainer(page: Page): Promise<string> {
    const bestSelector = await page.evaluate(() => {
        const getFiber = (el: any) => Object.keys(el || {}).find(k => k.startsWith('__reactFiber$'));
        const app = document.querySelector('#__APP');
        if (app && app.firstElementChild && getFiber(app.firstElementChild)) return '#__APP > div:first-child';
        if (getFiber(document.querySelector('#__APP'))) return '#__APP';
        if (getFiber(document.body)) return 'body';
        return '#__APP'; 
    });
    return bestSelector;
}

async function setupMemePage(
    browser: Browser, 
    browserScriptOriginal: string, 
    socket: Socket
): Promise<void> {
    logger.log(`[Setup] 初始化 Meme Rush (RAW DUMP MODE)...`, logger.LOG_LEVELS.INFO);
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    // ✨✨✨ 核心：接收来自 browser-script.js 的 safeLog 打印 ✨✨✨
    page.on('console', msg => {
        const text = msg.text();
        // 过滤掉无关的日志，只看我们关心的
        if (text.includes('RAW DATA') || text.includes('{') || text.includes('Smart Async')) {
             console.log(`🔎 [BROWSER] ${text}`);
        }
    });

    const handleExtractedData = (result: ExtractedDataPayload): void => {
        const { type, data, changedCount } = result;
        if (type !== 'no-change') {
             const time = new Date().toLocaleTimeString();
             logger.log(`⚡ [${TARGET.name}] ${time} | ${type.padEnd(8)} | 数量: ${String(changedCount).padEnd(3)}`, logger.LOG_LEVELS.INFO);
        }
        if (data && data.length > 0 && type !== 'no-change') {
            const enrichedData = data.map(item => ({ 
                ...item, chain: 'BSC', source: 'meme-rush', _scrapedAt: Date.now() 
            }));
            socket.emit('data-update', { category: TARGET.category, type: type, data: enrichedData });
        }
    };

    await page.exposeFunction('onDataExtracted', handleExtractedData);

    // 注入 originalConsoleLog
    await page.addInitScript({ content: `window.originalConsoleLog = console.log;` });

    try {
        logger.log(`[Navi] 前往: ${TARGET.url}`, logger.LOG_LEVELS.INFO);
        await page.goto(TARGET.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForSelector('div:has-text("TX")', { timeout: 10000 }); } catch(e) {}
        await page.waitForTimeout(2000); 

        const dynamicSelector = await detectStableContainer(page);
        logger.log(`[Target] 挂载点: ${dynamicSelector}`, logger.LOG_LEVELS.INFO);

        // 直接使用文件内容，不再做复杂的正则替换
        const options = {
            selectors: { stableContainer: dynamicSelector },
            interval: EXTRACTION_INTERVAL_MS,
            config: MEME_CONFIG.heuristic,
            desiredFields: MEME_CONFIG.desiredFields
        };

        const initScriptContent = `
            (() => {
                ${browserScriptOriginal}
                window.initializeExtractor(${JSON.stringify(options)});
            })();
        `;

        await page.evaluate(initScriptContent);
        await handleGuidePopup(page);
        await checkAndClickCookieBanner(page);

    } catch (error: any) {
        logger.log(`❌ [Navi] 错误: ${error.message}`, logger.LOG_LEVELS.ERROR);
        throw error;
    }

    logger.log(`✅ [Setup] 运行中. 应该能在日志中看到 'RAW DATA DUMP START' 了。`, logger.LOG_LEVELS.INFO);
}

async function main() {
    logger.init();
    logger.log('🚀 [MemeExtractor] 启动...', logger.LOG_LEVELS.INFO);
    const socket: Socket = io(SERVER_URL);
    let browser: Browser | undefined;
    try {
        const browserScriptPath = path.join(__dirname, '..', 'src', 'browser-script.js');
        const browserScript = await fs.readFile(browserScriptPath, 'utf-8');

        browser = await chromium.launch({
            executablePath: MY_CHROME_PATH,
            headless: false,
            proxy: { server: 'socks5://127.0.0.1:1080' },
            args: ['--start-maximized', '--no-sandbox']
        });

        await setupMemePage(browser, browserScript, socket);
        await new Promise(() => {});
    } catch (e: any) {
        logger.log(`❌ 错误: ${e.stack}`, logger.LOG_LEVELS.ERROR);
    } finally {
        socket.disconnect();
        if (browser) await browser.close();
        logger.close();
    }
}

main();