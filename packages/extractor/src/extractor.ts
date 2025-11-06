// packages/extractor/src/extractor.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright'; // 从 'playwright' 导入核心类型
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
import { applyVolumeFilter } from './filterManager';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
import type { ExtractedDataPayload } from 'shared-types';
// ✨ 核心修改: 从 shared-types 导入 DESIRED_FIELDS
import { DESIRED_FIELDS } from 'shared-types';

chromium.use(stealth());

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 10;
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

// ✨ 核心修改: 本地的 DESIRED_FIELDS 定义已被移除
// ==============================================================================

/**
 * 带有重试机制的页面导航函数, 它会确保导航成功且关键元素已加载
 * @param page Playwright Page 对象
 * @param url 要导航到的 URL
 * @param criticalSelector 必须等待其可见的关键元素选择器
 * @param maxRetries 最大重试次数
 */
async function gotoWithRetry(page: Page, url: string, criticalSelector: string, maxRetries: number = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.log(`[Navigation] 正在尝试第 ${attempt}/${maxRetries} 次访问: ${url}`, logger.LOG_LEVELS.INFO);

            // 步骤 1: 导航并等待基础页面资源加载完成
            await page.goto(url, { waitUntil: 'load', timeout: 90000 });
            logger.log(`[Navigation] 基础页面加载成功，正在等待关键元素...`, logger.LOG_LEVELS.INFO);

            // ✨ 核心优化: 精准等待我们需要的核心UI元素变得可见
            await page.waitForSelector(criticalSelector, { state: 'visible', timeout: 45000 });
            
            logger.log(`[Navigation] 关键元素 '${criticalSelector}' 已可见，页面完全就绪!`, logger.LOG_LEVELS.INFO);
            return; // 成功则直接返回

        } catch (error: any) {
            logger.log(`[Navigation] 第 ${attempt} 次访问失败: ${error.message}`, logger.LOG_LEVELS.ERROR);
            if (attempt === maxRetries) {
                logger.log(`[Navigation] 已达到最大重试次数，抛出错误。`, logger.LOG_LEVELS.ERROR);
                throw error; // 最后一次尝试失败，则抛出错误
            }
            const delay = 5000; // 等待5秒后重试
            logger.log(`[Navigation] 将在 ${delay / 1000} 秒后重试...`, logger.LOG_LEVELS.INFO);
            await page.waitForTimeout(delay);
        }
    }
}


async function main(): Promise<void> {
    logger.init();
    let browser: Browser | undefined;

    const socket: Socket = io(SERVER_URL);
    socket.on('connect', () => {
        logger.log(`✅ [Socket.IO] 成功连接到 Fastify 服务器: ${SERVER_URL}`, logger.LOG_LEVELS.INFO);
    });
    socket.on('connect_error', (err: Error) => {
        logger.log(`❌ [Socket.IO] 连接失败: ${err.message}. 请确认后端服务 (pnpm dev:backend) 已运行.`, logger.LOG_LEVELS.ERROR);
    });

    logger.log('🚀 [Extractor v5.0 TS] 脚本启动...', logger.LOG_LEVELS.INFO);

    try {
        const browserScript = await fs.readFile(path.join(__dirname, '..', 'src', 'browser-script.js'), 'utf-8');

        browser = await chromium.launch({
            executablePath: MY_CHROME_PATH,
            headless: false,
            proxy: { server: 'socks5://127.0.0.1:1080' },
            args: ['--start-maximized']
        });

        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();
        
        // ======================= ✨ [核心修改] ✨ =======================
        // [诊断] 旧的 page.evaluate + new Function() 方法很可能被网站的 CSP (内容安全策略) 阻止，导致脚本静默失败。
        // [解决方案] 使用 page.addInitScript() 在页面加载任何其他脚本之前注入我们的代码。这是一种更可靠、更能绕过CSP的方法。
        
        // ✨ 核心变更 1: 在导航前准备好注入脚本的所有内容和配置
        const options = {
            selectors: SELECTORS,
            interval: EXTRACTION_INTERVAL_MS,
            desiredFields: DESIRED_FIELDS,
            config: HEURISTIC_CONFIG
        };

        // 我们将脚本内容和启动调用合并成一个字符串
        const initScriptContent = `
            (() => {
                // 注入 browser-script.js 的完整内容
                ${browserScript}
                
                // 现在 initializeExtractor 函数已在 window 上定义，立即使用配置调用它
                window.initializeExtractor(${JSON.stringify(options)});
            })();
        `;
        
        // ✨ 核心变更 2: 使用 page.addInitScript 进行注入。这必须在 page.goto 之前调用。
        await page.addInitScript({ content: initScriptContent });
        
        // 同时也保留这个，用于备份原始的 console.log，确保我们的日志能正常工作
        await page.addInitScript({ content: 'window.originalConsoleLog = console.log;' });
        // =============================================================

        await gotoWithRetry(
            page, 
            'https://web3.binance.com/zh-CN/markets/trending?chain=bsc',
            SELECTORS.stableContainer
        );
        
        await handleGuidePopup(page);
        await checkAndClickCookieBanner(page);
        await applyVolumeFilter(page, MIN_VOLUME_FILTER);

        logger.log('✅ 页面初始化完成，提取器已注入并运行...', logger.LOG_LEVELS.INFO);

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
        
        // ✨ 核心变更 3: 移除旧的、不可靠的注入逻辑。
        // 旧的 page.evaluate 调用已被上面的 addInitScript 完全替代。

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