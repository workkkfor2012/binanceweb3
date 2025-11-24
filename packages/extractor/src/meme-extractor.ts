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
// --- ⚙️ Meme Rush 生产配置 (已更新字段) ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SERVER_URL = 'http://localhost:3001';
// ✨ 修改：频率调整为 500ms
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
    // ✨ 根据刚才的 RAW_DUMP 更新了字段列表
    desiredFields: [
        'contractAddress', 
        'symbol', 
        'name', 
        'marketCap',      // 代替 price
        'liquidity',      // 池子厚度
        'volume',         // 24h交易量
        'progress',       // 进度条
        'holders',        // 持有人数
        'countBuy',       // 买入次数
        'countSell',      // 卖出次数
        'createTime',     // 创建时间
        'firstSeen',      // 上线时间
        'twitter', 
        'telegram', 
        'website', 
        'icon',
        'exclusive',      // 是否独家
        'sensitiveToken'  // 是否敏感
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
    logger.log(`[Setup] 初始化 Meme Rush (Deep Check Mode)...`, logger.LOG_LEVELS.INFO);
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    // 1. 绑定回调
    const handleExtractedData = (result: ExtractedDataPayload): void => {
        const { type, data, changedCount } = result;
        
        // ✨ 500ms 一次，日志可能会很多，可以根据需要调整日志级别或注释掉
        if (type !== 'no-change') {
             const time = new Date().toLocaleTimeString();
             logger.log(`⚡ [${TARGET.name}] ${time} | ${type.padEnd(8)} | 数量: ${String(changedCount).padEnd(3)}`, logger.LOG_LEVELS.INFO);
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

    // 2. 日志转发
    await page.addInitScript({
        content: `
            window.originalConsoleLog = console.log;
            console.log = (...args) => {
                // 监听 RAW_DUMP
                if (args[0] && typeof args[0] === 'string' && args[0].includes('RAW_DUMP')) {
                    window.originalConsoleLog(args[0]); 
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

        // 3. 💉 注入多条数据打印逻辑
        let debugScript = browserScriptOriginal;
        
        const anchorLine = 'const totalCount = dataArray.length;';
        
        debugScript = debugScript.replace(
            anchorLine,
            `
            ${anchorLine}
            // --- 💉 注入点 START: 打印前5条数据 ---
            if (dataArray.length > 0) {
                // 这里的逻辑会被浏览器脚本的缓存逻辑覆盖，但下面的修改会去掉缓存逻辑
            }
            // --- 💉 注入点 END ---
            `
        );

        // 安全检查
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

        await page.evaluate(initScriptContent);

        // 4. 处理弹窗
        await handleGuidePopup(page);
        await checkAndClickCookieBanner(page);

    } catch (error: any) {
        logger.log(`❌ [Navi] 错误: ${error.message}`, logger.LOG_LEVELS.ERROR);
        throw error;
    }

    logger.log(`✅ [Setup] 运行中. 等待打印前 5 个币种详情...`, logger.LOG_LEVELS.INFO);
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
            headless: false, // 保持 headless
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