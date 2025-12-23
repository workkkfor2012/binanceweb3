// packages/extractor/src/extractor.ts
import * as fs from 'fs';
import * as fsp from 'fs/promises';
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
const EXTRACTION_INTERVAL_MS = 500; // 抓取频率
const EMIT_INTERVAL_MS = 500;       // 聚合发送频率
const SERVER_URL = 'http://localhost:30002';

// ✨ 配置分类：全是 hotlist
const TARGETS = [
    { name: 'BSC', category: 'hotlist', url: 'https://web3.binance.com/zh-CN/markets/trending?chain=bsc' },
    { name: 'SOL', category: 'hotlist', url: 'https://web3.binance.com/zh-CN/markets/trending?chain=sol' },
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

// 定义回调函数类型，用于更新全局状态
type UpdateStateCallback = (chainName: string, data: HotlistItem[]) => void;

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
    updateState: UpdateStateCallback // 👈 修改：不再传入 socket，而是传入更新回调
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
        const { type, data } = result;

        // 如果需要调试单链日志，可以使用 logger.log，这里为了避免未使用变量报错，移除了 perfString

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
                volume1m: parseFloat(item.volume1m) || 0,
                priceChange1m: parseFloat(item.priceChange1m) || 0,
                volume4h: parseFloat(item.volume4h) || 0,
                priceChange4h: parseFloat(item.priceChange4h) || 0,
                createTime: parseInt(item.createTime) || 0,
                liquidity: parseFloat(item.liquidity) || 0,

                source: 'hotlist'
            }));

            // ⚡️ 更新全局状态，而不是直接发送
            updateState(chainName, enrichedData);
        }
    };

    await page.exposeFunction('onDataExtracted', handleExtractedData);
    logger.log(`✅ [Setup][${chainName}] 页面初始化完成，提取器已注入并运行。`, logger.LOG_LEVELS.INFO);
}

// ==============================================================================
// --- 🔄 聚合逻辑 ---
// ==============================================================================
class DataAggregator {
    private store: Map<string, HotlistItem[]> = new Map();

    // 更新某个链的数据
    public update(chain: string, data: HotlistItem[]) {
        this.store.set(chain, data);
    }

    // 获取聚合后的数据
    public getMergedData(): HotlistItem[] {
        const allData: HotlistItem[] = [];
        for (const chainData of this.store.values()) {
            allData.push(...chainData);
        }
        return allData;
    }

    // 获取当前状态摘要（用于日志）
    public getStats(): string {
        const parts: string[] = [];
        let total = 0;
        for (const [chain, data] of this.store.entries()) {
            parts.push(`${chain}:${data.length}`);
            total += data.length;
        }
        return `[Total: ${total}] (${parts.join(', ')})`;
    }
}

async function main(): Promise<void> {
    logger.init();
    let browser: Browser | undefined;
    const socket: Socket = io(SERVER_URL, {
        transports: ['websocket'], // ✨ 强制直连 websocket，跳过可能在云服务器被拦截的 xhr 轮询
    });

    // 初始化聚合器
    const aggregator = new DataAggregator();

    socket.on('connect', () => logger.log(`✅ [Socket.IO] 成功连接到服务器: ${SERVER_URL}`, logger.LOG_LEVELS.INFO));
    socket.on('connect_error', (err: Error) => logger.log(`❌ [Socket.IO] 连接失败: ${err.message}.`, logger.LOG_LEVELS.ERROR));

    logger.log('🚀 [HotlistExtractor] 脚本启动 (聚合模式)...', logger.LOG_LEVELS.INFO);

    try {
        const browserScript = await fsp.readFile(path.join(__dirname, '..', 'src', 'browser-script.js'), 'utf-8');

        // ✨ 智能浏览器启动逻辑
        const hasChromePath = fs.existsSync(MY_CHROME_PATH);
        if (!hasChromePath) {
            logger.log(`⚠️ 指定的 Chrome 路径不存在: ${MY_CHROME_PATH}, 自动回退至系统 Edge 浏览器`, logger.LOG_LEVELS.INFO);
        }

        browser = await chromium.launch({
            executablePath: hasChromePath ? MY_CHROME_PATH : undefined,
            channel: hasChromePath ? undefined : 'msedge',
            headless: true,
            proxy: { server: 'socks5://127.0.0.1:1080' },
            args: ['--start-maximized']
        });

        // 定义更新回调
        const updateCallback: UpdateStateCallback = (chainName, data) => {
            aggregator.update(chainName, data);
        };

        const setupPromises = TARGETS.map(target =>
            setupPageForChain(browser!, browserScript, target, updateCallback)
        );
        await Promise.all(setupPromises);

        logger.log(`\n👍 所有 [${TARGETS.length}] 个页面初始化完毕，开始聚合发送循环。`, logger.LOG_LEVELS.INFO);

        // --- 🔄 启动聚合发送循环 ---
        setInterval(() => {
            const mergedData = aggregator.getMergedData();

            if (mergedData.length > 0) {
                // 发送合并后的数据
                socket.emit('data-update', {
                    category: 'hotlist',
                    type: 'merged-update', // 标识为合并更新
                    data: mergedData,
                    timestamp: Date.now()
                });

                // 打印聚合日志
                const stats = aggregator.getStats();
                process.stdout.write(`\r[${new Date().toLocaleTimeString()}] 📡 发送聚合数据 ${stats}      `);
            }
        }, EMIT_INTERVAL_MS);

        // 保持进程活跃
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