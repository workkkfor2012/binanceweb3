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
const SERVER_URL = 'http://localhost:3001';
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
// --- 🧠 核心扫描脚本 ---
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
                            // 优先取 migrateTime
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

            // 2. 深度扫描 (MAX_CLIMB = 60)
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
function normalizeData(rawItems: any[]): MemeItem[] {
    if (!Array.isArray(rawItems)) return [];

    return rawItems.map(raw => {
        const isMigrated = String(raw.migrateStatus) === 'true';
        
        // 🔥 【脏操作】核心逻辑：
        // 如果是已迁移品种，强制把 migrateTime 赋值给 createTime
        // 这样前端排序时，就会自动把刚迁移的排在最前面，而不需要修改任何前端代码
        const displayTime = isMigrated && raw.migrateTime 
            ? safeInt(raw.migrateTime) 
            : safeInt(raw.createTime);

        return {
            chain: 'BSC',
            contractAddress: raw.contractAddress || '',
            symbol: raw.symbol || 'UNKNOWN',
            name: raw.name || raw.symbol,
            icon: raw.icon === 'null' ? undefined : raw.icon,
            
            progress: safeFloat(raw.progress),
            status: isMigrated ? 'dex' : 'trading',
            
            holders: safeInt(raw.holders),
            marketCap: safeFloat(raw.marketCap),
            liquidity: safeFloat(raw.liquidity),
            volume: safeFloat(raw.volume),
            
            twitter: raw.twitter === 'null' ? null : raw.twitter,
            telegram: raw.telegram === 'null' ? null : raw.telegram,
            website: raw.website === 'null' ? null : raw.website,
            
            devMigrateCount: safeInt(raw.devMigrateCount),
            
            // 🔥 这里把处理好的时间塞进去
            createTime: displayTime || Date.now(),
            updateTime: Date.now(),
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

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('Content Security Policy') || text.includes('ERR_CONNECTION_CLOSED') || text.includes('Failed to load resource')) return;
        if (msg.type() === 'error' && !text.includes('TypeError')) console.log(`[Browser Err] ${text}`);
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
        
        logger.log(`[Init] 🖱️ 激活右侧区域...`, logger.LOG_LEVELS.INFO);
        const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        await page.waitForTimeout(500);
        await page.mouse.move(viewport.width * 0.8, viewport.height / 2);
        
        await page.evaluate(async () => {
            window.scrollTo(0, 500); await new Promise(r => setTimeout(r, 500));
            window.scrollTo(0, 0);   await new Promise(r => setTimeout(r, 500));
        });

        logger.log(`[Loop] 🚀 开始监听 [${CAPTURE_CONFIG.targetCategory}] (Strict Sort: migrateTime Desc)...`, logger.LOG_LEVELS.INFO);

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
                        await page.evaluate(SCANNER_LOGIC_SCRIPT).catch(() => {});
                    }
                    return null;
                });

                if (scanResult && scanResult.lists && scanResult.lists.length > 0) {
                    noDataCount = 0;
                    const lists = scanResult.lists;
                    const targetLists = lists.filter((l:any) => l.type === CAPTURE_CONFIG.targetCategory);
                    
                    if (targetLists.length > 0) {
                        targetLists.sort((a:any, b:any) => b.time - a.time);
                        const bestList = targetLists[0];
                        const topData = bestList.data;

                        if (topData && topData.length > 0) {
                            // 🔥 强制排序：按 migrateTime 倒序
                            topData.sort((a: any, b: any) => {
                                const tA = parseInt(a.migrateTime || '0');
                                const tB = parseInt(b.migrateTime || '0');
                                return tB - tA;
                            });

                            const firstRaw = topData[0];
                            const currentSymbol = firstRaw.symbol;
                            const showTime = parseInt(firstRaw.migrateTime || firstRaw.createTime);

                            if (currentSymbol !== lastTopSymbol) {
                                console.log('\n'); 
                                logger.log(
                                    `🔥 [NEW MIGRATED] Symbol: ${currentSymbol} | Count: ${bestList.count} | MigratedTime: ${new Date(showTime).toLocaleTimeString()}`,
                                    logger.LOG_LEVELS.INFO
                                );
                                
                                // 🔥 详细验证：打印前三名的时间，证明是排序过的
                                console.log('--------------------------------------------------');
                                console.log('✅ [Verify Sorting] Top 3 Latest Migrated Tokens:');
                                topData.slice(0, 5).forEach((item: any, idx: number) => {
                                    const mt = parseInt(item.migrateTime || '0');
                                    console.log(`   #${idx+1} ${item.symbol.padEnd(8)} | Time: ${new Date(mt).toLocaleTimeString()} (${mt})`);
                                });
                                console.log('--------------------------------------------------');

                                lastTopSymbol = currentSymbol;
                            }
                            
                            if (loopCount % 5 === 0) {
                                process.stdout.write(`\r[Scan #${loopCount}] Migrated: ${topData.length} items [Top: ${currentSymbol}]      `);
                            }

                            const items = normalizeData(topData.slice(0, 40));
                            socket.emit('data-update', { 
                                category: `meme_${CAPTURE_CONFIG.targetCategory}`, 
                                type: 'full', 
                                data: items 
                            });
                        }
                    } else {
                        if (loopCount % 5 === 0) process.stdout.write(`\r[Scan #${loopCount}] ⏳ No migrated lists yet...`);
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

        await new Promise(() => {});

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
            headless: false,
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