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
// --- ⚙️ Meme Rush 透视配置 ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SERVER_URL = 'http://localhost:3001';
const EXTRACTION_INTERVAL_MS = 1000;

const TARGET = {
    name: 'BSC_MEME',
    url: 'https://web3.binance.com/zh-CN/meme-rush?chain=bsc',
    category: 'meme_new' 
};

// 保持配置不变
const MEME_CONFIG = {
    heuristic: {
        maxFiberTreeDepth: 100, 
        minArrayLength: 2, 
        requiredKeys: ['symbol', 'contractAddress'], 
    },
    desiredFields: [
        'contractAddress', 'symbol', 'name', 
        'price', 'priceChange24h', 
        'marketCap', 'volume24h', 
        'progress', 'firstSeen', 'createTime',
        'twitter', 'telegram', 'website', 'icon'
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
    logger.log(`[Setup] 初始化 Meme Rush (透视模式)...`, logger.LOG_LEVELS.INFO);
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    // 1. 绑定回调
    const handleExtractedData = (result: ExtractedDataPayload): void => {
        const { type, data, changedCount } = result;
        
        if (type !== 'no-change') {
             const time = new Date().toLocaleTimeString();
             logger.log(`⚡ [${TARGET.name}] ${time} | ${type.padEnd(8)} | 变更: ${String(changedCount).padEnd(3)}`, logger.LOG_LEVELS.INFO);
        }

        if (data && data.length > 0 && type !== 'no-change') {
            const enrichedData = data.map(item => ({ 
                ...item, 
                chain: 'BSC', 
                source: 'meme-rush', 
                _scrapedAt: Date.now() 
            }));
            socket.emit('data-update', { category: TARGET.category, type: type, data: enrichedData });
        }
    };

    await page.exposeFunction('onDataExtracted', handleExtractedData);

    // 2. 注入日志转发，专门监听 [RAW_DUMP]
    await page.addInitScript({
        content: `
            window.originalConsoleLog = console.log;
            console.log = (...args) => {
                // 只要包含 RAW_DUMP 就强制打印，忽略其他
                if (args[0] && typeof args[0] === 'string' && args[0].includes('RAW_DUMP')) {
                    window.originalConsoleLog(args[0]); 
                }
                // 打印关键错误
                if (args[0] && typeof args[0] === 'string' && args[0].includes('CRITICAL')) {
                    window.originalConsoleLog('[Browser]', ...args);
                }
            };
        `
    });

    try {
        logger.log(`[Navi] 前往: ${TARGET.url}`, logger.LOG_LEVELS.INFO);
        await page.goto(TARGET.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForSelector('div:has-text("TX")', { timeout: 10000 }); } catch(e) {}
        await page.waitForTimeout(2000); 

        const dynamicSelector = await detectStableContainer(page);
        logger.log(`[Target] 挂载点: ${dynamicSelector}`, logger.LOG_LEVELS.INFO);

        // 3. 💉 修正后的代码注入
        let debugScript = browserScriptOriginal;
        
        // 【关键修正】使用唯一的代码行作为锚点，确保注入到 extractData 内部
        const anchorLine = 'const totalCount = dataArray.length;';
        
        debugScript = debugScript.replace(
            anchorLine,
            `
            ${anchorLine}
            // --- 💉 注入点 START ---
            // 只有当有数据，且缓存为空（第一次运行）时，打印第一条数据的原始内容
            if (dataArray.length > 0 && Object.keys(dataStateCache).length === 0) {
                const rawItem = dataArray[0];
                // 打印整个对象结构
                safeLog("🔥 [RAW_DUMP] " + JSON.stringify(rawItem));
            }
            // --- 💉 注入点 END ---
            `
        );

        // 安全调用封装
        debugScript = debugScript.replace(
            /window\.onDataExtracted\(payload\);/g,
            `if (typeof window.onDataExtracted === 'function') { window.onDataExtracted(payload); }`
        );

        const options = {
            selectors: { stableContainer: dynamicSelector },
            interval: EXTRACTION_INTERVAL_MS,
            config: MEME_CONFIG.heuristic,
            desiredFields: MEME_CONFIG.desiredFields
        };

        const initScriptContent = `
            (() => {
                ${debugScript}
                window.initializeExtractor(${JSON.stringify(options)});
            })();
        `;

        // 注入并启动
        await page.evaluate(initScriptContent);

        // 4. 处理弹窗
        await handleGuidePopup(page);
        await checkAndClickCookieBanner(page);

    } catch (error: any) {
        logger.log(`❌ [Navi] 错误: ${error.message}`, logger.LOG_LEVELS.ERROR);
        throw error;
    }

    logger.log(`✅ [Setup] 透视模式运行中，请等待 [RAW_DUMP] 日志...`, logger.LOG_LEVELS.INFO);
}

async function main() {
    logger.init();
    logger.log('🚀 [MemeExtractor] 修复版启动...', logger.LOG_LEVELS.INFO);
    const socket: Socket = io(SERVER_URL);
    let browser: Browser | undefined;
    
    try {
        const browserScriptPath = path.join(__dirname, '..', 'src', 'browser-script.js');
        const browserScript = await fs.readFile(browserScriptPath, 'utf-8');

        browser = await chromium.launch({
            executablePath: MY_CHROME_PATH,
            headless: false, // 保持 headless 以专注于日志
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