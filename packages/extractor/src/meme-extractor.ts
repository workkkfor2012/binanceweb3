// packages/extractor/src/meme-extractor.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
// 引入类型
import type { ExtractedDataPayload, MemeItem } from 'shared-types';
import type { MemeRushRawItem } from 'shared-types/src/meme-rush';

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
    // ✨ 关键区分点：Category 设为 meme_new
    category: 'meme_new' 
};

// 浏览器脚本使用的配置
const MEME_CONFIG = {
    heuristic: {
        maxFiberTreeDepth: 100, 
        minArrayLength: 2, 
        requiredKeys: ['symbol', 'contractAddress'], 
    },
    // 需要从 React Fiber 中提取的原始字段
    desiredFields: [
        'contractAddress', 'symbol', 'name', 'marketCap', 'liquidity',      
        'volume', 'progress', 'holders', 'createTime', 'twitter', 
        'telegram', 'website', 'icon', 'devMigrateCount'
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
    logger.log(`[Setup] 初始化 Meme Rush (MemeNew 模式)...`, logger.LOG_LEVELS.INFO);
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('RAW DATA') || text.includes('Smart Async')) {
             console.log(`🔎 [BROWSER] ${text}`);
        }
    });

    // ✨ 数据处理回调：将 RawItem 转换为 MemeItem
    const handleExtractedData = (result: ExtractedDataPayload): void => {
        const { type, data, changedCount } = result;

        if (type !== 'no-change') {
             const time = new Date().toLocaleTimeString();
             logger.log(`⚡ [${TARGET.name}] ${time} | ${type.padEnd(8)} | 数量: ${String(changedCount).padEnd(3)}`, logger.LOG_LEVELS.INFO);
        }

        if (data && data.length > 0 && type !== 'no-change') {
            // 强制类型转换为原始抓取类型
            const rawItems = data as unknown as MemeRushRawItem[];

            // 映射到 Shared Types 的 MemeItem
            const enrichedData: MemeItem[] = rawItems.map(raw => ({
                // --- BaseItem ---
                chain: 'BSC',
                contractAddress: raw.contractAddress,
                symbol: raw.symbol,
                icon: raw.icon,
                updateTime: Date.now(),
                source: 'meme-rush',

                // --- MemeItem 特有 ---
                name: raw.name || raw.symbol, // 防止 name 为空
                progress: raw.progress || 0,
                holders: raw.holders || 0,
                devMigrateCount: raw.devMigrateCount || 0,
                createTime: raw.createTime || 0,
                
                twitter: raw.twitter || undefined,
                telegram: raw.telegram || undefined,
                website: raw.website || undefined,
                
                liquidity: raw.liquidity || 0,
                marketCap: raw.marketCap || 0,
                
                // 简单的状态推断逻辑
                status: (raw.progress || 0) >= 100 ? 'dex' : 'trading'
            }));

            // 发送 Payload，Category 必须是 'meme_new' 以匹配后端 Enum
            socket.emit('data-update', { 
                category: TARGET.category, 
                type: type, 
                data: enrichedData 
            });
        }
    };

    await page.exposeFunction('onDataExtracted', handleExtractedData);
    await page.addInitScript({ content: `window.originalConsoleLog = console.log;` });

    try {
        logger.log(`[Navi] 前往: ${TARGET.url}`, logger.LOG_LEVELS.INFO);
        await page.goto(TARGET.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        try { await page.waitForSelector('div:has-text("TX")', { timeout: 10000 }); } catch(e) {}
        await page.waitForTimeout(2000); 

        const dynamicSelector = await detectStableContainer(page);
        logger.log(`[Target] 挂载点: ${dynamicSelector}`, logger.LOG_LEVELS.INFO);

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
        await new Promise(() => {}); // 保持进程运行
    } catch (e: any) {
        logger.log(`❌ 错误: ${e.stack}`, logger.LOG_LEVELS.ERROR);
    } finally {
        socket.disconnect();
        if (browser) await browser.close();
        logger.close();
    }
}

main();