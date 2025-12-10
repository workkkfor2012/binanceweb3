// packages/extractor/src/meme-extractor.ts
import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
import type { MemeItem } from 'shared-types';

chromium.use(stealth());

// ==============================================================================
// --- ⚙️ 配置区域 ---
// ==============================================================================
const SERVER_URL = 'http://localhost:3002';
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET_URL = 'https://web3.binance.com/zh-CN/meme-rush?chain=bsc';

const CAPTURE_CONFIG = {
    // 🎯 目标: 'migrated'
    targetCategory: 'migrated' as 'new' | 'migrated',
    interval: 1000,
    proxy: 'socks5://127.0.0.1:1080',
    maxRetries: 5
};

// ==============================================================================
// --- 🧠 核心扫描脚本 (Browser Context) ---
// ==============================================================================
const SCANNER_LOGIC_SCRIPT = `
(() => {
    window.MemeScannerEngine = {
        fiberCache: null,

        getReactFiber(el) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            return key ? el[key] : null;
        },

        isValidTokenList(list) {
            if (!Array.isArray(list) || list.length < 2) return false;
            const first = list[0];
            if (!first || typeof first !== 'object') return false;
            return !!first.symbol;
        },

        identifyType(list) {
            const first = list[0];
            const mStatus = String(first.migrateStatus);
            const progress = parseFloat(first.progress || '0');
            // 进度大于99或状态为true视为已迁移
            if (mStatus === 'true' || progress >= 99) return 'migrated';
            return 'new';
        },

        scan() {
            // 1. 缓存策略
            if (this.fiberCache) {
                try {
                    const data = this.fiberCache.memoizedProps?.value || this.fiberCache.memoizedProps;
                    let list = null;
                    if (data) {
                        if (Array.isArray(data.allTokens)) list = data.allTokens;
                        else if (Array.isArray(data.currentTokens)) list = data.currentTokens;
                        else if (Array.isArray(data)) list = data;
                        else {
                             Object.values(data).forEach(v => {
                                if (this.isValidTokenList(v)) list = v;
                             });
                        }
                    }

                    if (list && this.isValidTokenList(list)) {
                        const type = this.identifyType(list);
                        if (type === '${CAPTURE_CONFIG.targetCategory}') {
                            const time = type === 'migrated' 
                                ? parseInt(list[0].migrateTime || 0)
                                : parseInt(list[0].createTime || list[0].startTime || 0);

                            return [{
                                source: 'cache',
                                type: type,
                                count: list.length,
                                time: time,
                                data: list
                            }];
                        }
                    }
                } catch(e) {}
                this.fiberCache = null; 
            }

            // 2. 深度扫描
            const allElements = document.querySelectorAll('div, span, section, main, ul, li, a, img, h2, h3');
            const visitedFibers = new WeakSet();
            const foundLists = [];

            for (const el of allElements) {
                let fiber = this.getReactFiber(el);
                let depth = 0;
                const MAX_CLIMB = 60; 

                while (fiber && depth < MAX_CLIMB) {
                    if (visitedFibers.has(fiber)) {
                        fiber = fiber.return;
                        depth++;
                        continue;
                    }
                    visitedFibers.add(fiber);

                    const sources = [
                        fiber.memoizedProps?.value,
                        fiber.memoizedProps,
                        fiber.memoizedState
                    ];

                    for (const data of sources) {
                        if (!data || typeof data !== 'object') continue;

                        Object.keys(data).forEach(key => {
                            const val = data[key];
                            if (this.isValidTokenList(val)) {
                                const type = this.identifyType(val);
                                
                                if (type === '${CAPTURE_CONFIG.targetCategory}' && !this.fiberCache) {
                                    this.fiberCache = fiber; 
                                }

                                const time = type === 'migrated' 
                                    ? parseInt(val[0].migrateTime || 0)
                                    : parseInt(val[0].createTime || val[0].startTime || 0);

                                foundLists.push({
                                    source: 'scan',
                                    type: type,
                                    count: val.length,
                                    time: time,
                                    keyName: key,
                                    data: val
                                });
                            }
                        });
                    }
                    fiber = fiber.return;
                    depth++;
                }
            }
            return foundLists;
        }
    };
})();
`;

// ==============================================================================
// --- 🛠️ 增强的数据清洗工具 (Robust Utilities) ---
// ==============================================================================

function safeFloat(val: any): number {
    if (val === 'null' || val === null || val === undefined) return 0;
    const num = parseFloat(val);
    return isNaN(num) ? 0 : num;
}

function safeInt(val: any): number {
    if (val === 'null' || val === null || val === undefined) return 0;
    const num = parseInt(val, 10);
    return isNaN(num) ? 0 : num;
}

function safeBool(val: any): boolean {
    if (val === 'null' || val === null || val === undefined) return false;
    if (typeof val === 'boolean') return val;
    return String(val).toLowerCase() === 'true';
}

/**
 * 🛡️ 高级数据清洗器 (Advanced Data Sanitizer)
 * 核心思想：防止 API 抖动导致的虚假归零，同时能够识别真实的 Rug Pull
 */
interface LiqState {
    lastValidLiq: number;
    abnormalCount: number; // 连续异常次数
}

class AdvancedDataSanitizer {
    // 内存缓存：Key = ContractAddress
    private cache = new Map<string, LiqState>();

    // 容忍度：连续 5 次（约5秒）异常才视为真实暴跌
    private readonly MAX_ABNORMAL_TOLERANCE = 10;

    /**
     * 批量处理 MemeItem 列表，应用防抖逻辑
     */
    public process(items: MemeItem[]): MemeItem[] {
        // 创建一个新的数组返回，避免修改原始引用的隐式副作用（虽然此处 normalizedData 已经是新的对象）
        return items.map(item => {
            const key = item.contractAddress;
            const newLiq = item.liquidity;

            // 1. 数据无效，直接跳过处理
            if (typeof newLiq !== 'number' || isNaN(newLiq)) {
                return item;
            }

            let state = this.cache.get(key);

            // 2. 初始化：第一次见到该币种
            if (!state) {
                this.cache.set(key, { lastValidLiq: newLiq, abnormalCount: 0 });
                return item;
            }

            // 3. 检测暴跌逻辑 (> 50% 下跌)
            if (state.lastValidLiq > 0 && newLiq < state.lastValidLiq * 0.5) {
                state.abnormalCount++;

                if (state.abnormalCount <= this.MAX_ABNORMAL_TOLERANCE) {
                    // CASE A: 可能是接口抖动，进行拦截
                    // 使用旧的有效值覆盖新值
                    logger.log(`[Sanitizer] 🛡️ 拦截异常波动 [${item.symbol}] Liq: ${state.lastValidLiq} -> ${newLiq} (Count: ${state.abnormalCount})`, logger.LOG_LEVELS.INFO);
                    item.liquidity = state.lastValidLiq;
                } else {
                    // CASE B: 连续多次低值，确认为真实暴跌/撤池
                    logger.log(`[Sanitizer] 📉 确认暴跌/撤池 [${item.symbol}] Liq: ${state.lastValidLiq} -> ${newLiq} (Accepted after ${this.MAX_ABNORMAL_TOLERANCE} checks)`, logger.LOG_LEVELS.INFO);
                    state.lastValidLiq = newLiq;
                    state.abnormalCount = 0; // 重置计数器
                }
            } else {
                // CASE C: 数据正常（平稳、上涨、或正常范围下跌）
                // 立即更新缓存为最新值
                state.lastValidLiq = newLiq;
                state.abnormalCount = 0;
            }

            // 更新状态
            this.cache.set(key, state);
            return item;
        });
    }

    /**
     * 简单维护：清理过期的 key (避免 Map 无限膨胀)
     * 在高频交易对中，可以定期调用
     */
    public prune(activeAddresses: string[]) {
        const activeSet = new Set(activeAddresses);
        for (const key of this.cache.keys()) {
            if (!activeSet.has(key)) {
                this.cache.delete(key);
            }
        }
    }
}

/**
 * 核心清洗函数：将 Raw Data 映射为类型安全的 MemeItem
 * 包含所有风险指标、交易计数、时间戳
 */
function normalizeData(rawItems: any[]): MemeItem[] {
    if (!Array.isArray(rawItems)) return [];

    return rawItems.map(raw => {
        const isMigrated = String(raw.migrateStatus) === 'true';

        // 原始时间戳
        const migrateTime = safeInt(raw.migrateTime);
        const createTime = safeInt(raw.createTime);

        // 排序用时间：如果已迁移，优先展示迁移时间(发射时间)
        const displayTime = (isMigrated && migrateTime > 0) ? migrateTime : createTime;

        // 计算买卖比
        const countBuy = safeInt(raw.countBuy);
        const countSell = safeInt(raw.countSell);
        const buySellRatio = countSell > 0
            ? parseFloat((countBuy / countSell).toFixed(2))
            : countBuy; // 防止除以0

        return {
            // --- 基础 ---
            chain: 'BSC', // 原始数据 chainId: "56"
            contractAddress: raw.contractAddress || '',
            symbol: raw.symbol || 'UNKNOWN',
            name: raw.name || raw.symbol,
            icon: raw.icon === 'null' ? undefined : raw.icon,
            decimal: safeInt(raw.decimal),

            // --- 状态与时间 ---
            status: isMigrated ? 'dex' : 'trading',
            progress: safeFloat(raw.progress),
            createTime: createTime,
            migrateTime: migrateTime,
            displayTime: displayTime,
            updateTime: Date.now(),

            // --- 资金与交易 ---
            liquidity: safeFloat(raw.liquidity),
            marketCap: safeFloat(raw.marketCap),
            volume: safeFloat(raw.volume),
            holders: safeInt(raw.holders),
            count: safeInt(raw.count),
            countBuy: countBuy,
            countSell: countSell,
            buySellRatio: buySellRatio,

            // --- 🚩 风险/筹码分布 (重要!) ---
            holdersSniperPercent: safeFloat(raw.holdersSniperPercent),
            holdersTop10Percent: safeFloat(raw.holdersTop10Percent),
            holdersDevPercent: safeFloat(raw.holdersDevPercent),
            holdersInsiderPercent: safeFloat(raw.holdersInsiderPercent),
            devSellPercent: safeFloat(raw.devSellPercent),
            sensitiveToken: safeBool(raw.sensitiveToken),
            exclusive: safeBool(raw.exclusive),

            // --- 开发者历史 ---
            devMigrateCount: safeInt(raw.devMigrateCount),

            // --- 推广与社交 ---
            paidOnDexScreener: safeBool(raw.paidOnDexScreener),
            twitter: raw.twitter === 'null' ? null : raw.twitter,
            telegram: raw.telegram === 'null' ? null : raw.telegram,
            website: raw.website === 'null' ? null : raw.website,

            source: 'meme-rush'
        };
    });
}

// ==============================================================================
// --- 🚀 主流程 ---
// ==============================================================================

async function ensurePageReady(page: Page): Promise<boolean> {
    logger.log(`[Inject] 注入扫描引擎...`, logger.LOG_LEVELS.INFO);
    await page.evaluate(SCANNER_LOGIC_SCRIPT);
    return true;
}

async function setupMemePage(browser: Browser, socket: Socket): Promise<void> {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    // ✨ 初始化数据清洗器
    const sanitizer = new AdvancedDataSanitizer();

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('Content Security Policy') || text.includes('ERR_CONNECTION_CLOSED')) return;
        if (msg.type() === 'error' && !text.includes('TypeError')) { /* quiet */ }
    });

    try {
        let attempts = 0;
        let success = false;
        while (attempts < CAPTURE_CONFIG.maxRetries && !success) {
            try {
                attempts++;
                logger.log(`[Navi] (尝试 ${attempts}/${CAPTURE_CONFIG.maxRetries}) 前往: ${TARGET_URL}`, logger.LOG_LEVELS.INFO);
                await page.goto(TARGET_URL, { waitUntil: 'commit', timeout: 45000 });
                success = true;
                logger.log(`[Navi] ✅ 页面加载成功`, logger.LOG_LEVELS.INFO);
            } catch (err: any) {
                logger.log(`[Navi] ⚠️ 连接失败: ${err.message.split('\n')[0]}`, logger.LOG_LEVELS.INFO);
                if (attempts < CAPTURE_CONFIG.maxRetries) await new Promise(r => setTimeout(r, 3000));
                else throw new Error(`达到最大重试次数`);
            }
        }

        await ensurePageReady(page);
        await handleGuidePopup(page);
        await checkAndClickCookieBanner(page);

        // 模拟鼠标激活页面
        const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        await page.evaluate(async () => {
            window.scrollTo(0, 500); await new Promise(r => setTimeout(r, 500));
            window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 500));
        });

        logger.log(`[Loop] 🚀 开始监听 [${CAPTURE_CONFIG.targetCategory}] (Full Data Mode)...`, logger.LOG_LEVELS.INFO);

        let lastTopSymbol = '';
        let loopCount = 0;
        let noDataCount = 0;

        setInterval(async () => {
            loopCount++;

            try {
                const scanResult: any = await page.evaluate(() => {
                    // @ts-ignore
                    if (!window.MemeScannerEngine) return null;
                    // @ts-ignore
                    return { lists: window.MemeScannerEngine.scan() };
                }).catch(async (e) => {
                    if (e.message.includes('Execution context was destroyed')) {
                        await page.evaluate(SCANNER_LOGIC_SCRIPT).catch(() => { });
                    }
                    return null;
                });

                if (scanResult && scanResult.lists && scanResult.lists.length > 0) {
                    noDataCount = 0;
                    const lists = scanResult.lists;
                    const targetLists = lists.filter((l: any) => l.type === CAPTURE_CONFIG.targetCategory);

                    if (targetLists.length > 0) {
                        targetLists.sort((a: any, b: any) => b.time - a.time);
                        const bestList = targetLists[0];
                        const topData = bestList.data; // Raw Data Objects

                        if (topData && topData.length > 0) {
                            // 1. 强制按时间倒序 (MigrateTime > CreateTime)
                            topData.sort((a: any, b: any) => {
                                const tA = parseInt(a.migrateTime || a.createTime || '0');
                                const tB = parseInt(b.migrateTime || b.createTime || '0');
                                return tB - tA;
                            });

                            const firstRaw = topData[0];
                            const currentSymbol = firstRaw.symbol;
                            const showTimeTs = parseInt(firstRaw.migrateTime || firstRaw.createTime);

                            // 2. 发现新头部币种时，打印丰富的调试信息
                            if (currentSymbol !== lastTopSymbol) {
                                logger.log(`\n🔥 [NEW TOP] ${currentSymbol} found! Count: ${bestList.count}`, logger.LOG_LEVELS.INFO);

                                console.log('   --------------------------------------------------------');
                                console.log(`   ⏰ Time:     ${new Date(showTimeTs).toLocaleTimeString()} (Ts: ${showTimeTs})`);
                                console.log(`   📊 Buy/Sell: ${firstRaw.countBuy} / ${firstRaw.countSell}`);
                                console.log(`   🔫 Sniper%:  ${firstRaw.holdersSniperPercent}%`);
                                console.log(`   📢 Ads:      ${firstRaw.paidOnDexScreener}`);
                                console.log(`   🏆 DevExp:   ${firstRaw.devMigrateCount} launches`);
                                console.log('   --------------------------------------------------------');

                                lastTopSymbol = currentSymbol;
                            }

                            if (loopCount % 5 === 0) {
                                process.stdout.write(`\r[Scan #${loopCount}] Fetched ${topData.length} items. Top: ${currentSymbol.padEnd(6)} `);
                            }

                            // 3. 核心步骤：清洗并全量推送
                            // 即使资源充裕，通常只要前50-100个最热/最新的即可
                            const rawSlice = topData.slice(0, 60);
                            let items = normalizeData(rawSlice);

                            // ✨ 应用数据清洗器：防抖动，防错误归零 ✨
                            items = sanitizer.process(items);

                            socket.emit('data-update', {
                                category: `meme_${CAPTURE_CONFIG.targetCategory}`,
                                type: 'full',
                                data: items
                            });

                            // 偶尔清理一下缓存，防止 map 无限增长 (每 100 次循环清理一次)
                            if (loopCount % 100 === 0) {
                                const activeAddresses = items.map(i => i.contractAddress);
                                sanitizer.prune(activeAddresses);
                            }
                        }
                    } else {
                        if (loopCount % 5 === 0) process.stdout.write(`\r[Scan #${loopCount}] ⏳ No target lists...`);
                    }
                } else {
                    noDataCount++;
                    if (loopCount % 5 === 0) process.stdout.write(`\r[Scan #${loopCount}] ⏳ 暂无数据...`);

                    if (noDataCount > 30) {
                        logger.log(`\n[Auto-Fix] 数据流中断，刷新页面...`, logger.LOG_LEVELS.INFO);
                        noDataCount = 0;
                        await page.reload({ waitUntil: 'commit' });
                        await ensurePageReady(page);
                    }
                }

            } catch (err: any) {
                if (!err.message.includes('Context was destroyed')) {
                    logger.log(`\n❌ Loop Error: ${err.message}`, logger.LOG_LEVELS.ERROR);
                }
            }
        }, CAPTURE_CONFIG.interval);

        await new Promise(() => { });

    } catch (error: any) {
        logger.log(`❌ Setup Error: ${error.message}`, logger.LOG_LEVELS.ERROR);
    }
}

async function main() {
    logger.init();
    const socket: Socket = io(SERVER_URL);
    let browser: Browser | undefined;

    try {
        browser = await chromium.launch({
            executablePath: MY_CHROME_PATH,
            headless: true,
            args: [
                '--start-maximized',
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                `--proxy-server=${CAPTURE_CONFIG.proxy}`,
                '--ignore-certificate-errors'
            ],
        });

        await setupMemePage(browser, socket);

    } catch (e: any) {
        logger.log(`❌ Main Error: ${e.stack}`, logger.LOG_LEVELS.ERROR);
    }
}

main();