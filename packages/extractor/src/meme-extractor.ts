// packages/extractor/src/meme-extractor.ts
import { chromium } from 'playwright-extra';
import type { Browser } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import { handleGuidePopup, checkAndClickCookieBanner } from './pageInitializer';
import * as logger from './logger';
import { io, Socket } from 'socket.io-client';
// 引入类型
import type { MemeItem } from 'shared-types';


chromium.use(stealth());

// ==============================================================================
// --- ⚙️ 核心配置区域 ---
// ==============================================================================
const SERVER_URL = 'http://localhost:3001';
// Windows 路径注意转义
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET_URL = 'https://web3.binance.com/zh-CN/meme-rush?chain=bsc';

const CAPTURE_CONFIG = {
    // 🎯 这里配置你想爬取的目标: 'new' 或 'migrated'
    targetCategory: 'migrated' as 'new' | 'migrated',

    // 抓取频率 (毫秒)
    interval: 1000,

    // 代理配置
    proxy: 'socks5://127.0.0.1:1080'
};

// ==============================================================================

/**
 * 🧠 浏览器内注入的智能脚本
 * 包含了 V9 的全链路爬升逻辑 + 特征分类逻辑
 */
const INTELLIGENT_READER_SCRIPT = `
(() => {
    window.MemeReader = {
        cache: {
            new: null,
            migrated: null
        },

        getReactFiber(el) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            return key ? el[key] : null;
        },

        // --- 🧬 数据指纹分类器 ---
        classifyList(list) {
            if (!Array.isArray(list) || list.length === 0) return 'unknown';
            
            // 采样前 5 个数据计算平均进度
            const samples = list.slice(0, 5);
            const totalProgress = samples.reduce((acc, cur) => acc + (cur.progress || 0), 0);
            const avgProgress = totalProgress / samples.length;
            
            // 规则: 已迁移 -> 进度通常是 100% 或接近 100%
            if (samples.some(i => i.progress >= 100) || avgProgress > 99) {
                return 'migrated';
            }

            // 规则: 新币 -> 进度较低 (通常 < 20%)
            // 注意：这里我们忽略 'upcoming' (中间进度的那些)，只区分 New 和 Migrated
            if (avgProgress < 50) {
                return 'new';
            }
            
            return 'unknown';
        },

        scan() {
            const targetKey = '${CAPTURE_CONFIG.targetCategory}';
            
            // 1. 检查缓存是否有效
            if (this.cache[targetKey]) {
                try {
                    const cachedData = this.cache[targetKey].memoizedProps.value.allTokens;
                    if (cachedData && cachedData.length > 0) {
                        return cachedData; // ✅ 缓存命中
                    }
                } catch (e) {
                    console.log('Cache stale, rescanning...');
                    this.cache[targetKey] = null;
                }
            }

            console.log('🔍 Full scan for category: ' + targetKey);
            
            // 2. 开始全链路爬升
            const visited = new WeakSet();
            const allElements = document.querySelectorAll('div, span, section');

            for (const el of allElements) {
                let fiber = this.getReactFiber(el);
                let depth = 0;
                
                while (fiber && depth < 80) {
                    if (visited.has(fiber)) {
                        fiber = fiber.return;
                        depth++;
                        continue;
                    }
                    visited.add(fiber);

                    const candidates = [fiber.memoizedProps?.value, fiber.memoizedProps];
                    
                    for (const source of candidates) {
                        if (source && Array.isArray(source.allTokens) && source.allTokens.length > 0) {
                            const type = this.classifyList(source.allTokens);
                            
                            if (type !== 'unknown') {
                                this.cache[type] = fiber;
                            }
                        }
                    }

                    if (this.cache[targetKey]) {
                        return this.cache[targetKey].memoizedProps.value.allTokens;
                    }

                    fiber = fiber.return;
                    depth++;
                }
            }
            
            return null; // 没找到
        }
    };
})();
`;

// --- 数据标准化 ---
function normalizeData(rawItems: any[], category: string): MemeItem[] {
    if (!Array.isArray(rawItems)) return [];

    return rawItems.map(raw => {
        // 简单的状态映射
        // category === 'migrated' -> 'dex'
        // category === 'new' -> 'trading'
        const status: MemeItem['status'] = category === 'migrated' ? 'dex' : 'trading';

        return {
            // 基础字段
            chain: 'BSC',
            contractAddress: raw.contractAddress || raw.address || '',
            symbol: raw.symbol || 'UNKNOWN',
            name: raw.name || raw.symbol,
            icon: raw.icon,
            
            // 核心数据
            progress: typeof raw.progress === 'number' ? raw.progress : 0,
            status: status,
            
            // 数值
            holders: raw.holders || 0,
            marketCap: raw.marketCap || 0,
            liquidity: raw.liquidity || 0,
            volume: raw.volume || 0,
            devMigrateCount: raw.devMigrateCount || 0,
            
            // 社交
            twitter: raw.twitter,
            telegram: raw.telegram,
            website: raw.website,
            
            // 时间
            createTime: raw.createTime || raw.startTime || Date.now(),
            updateTime: Date.now(),
            source: 'meme-rush'
        };
    });
}

async function setupMemePage(browser: Browser, socket: Socket): Promise<void> {
    const category = CAPTURE_CONFIG.targetCategory;
    logger.log(`[Setup] 初始化爬虫 | 目标板块: [${category.toUpperCase()}]`, logger.LOG_LEVELS.INFO);

    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    try {
        logger.log(`[Navi] 前往: ${TARGET_URL}`, logger.LOG_LEVELS.INFO);
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        logger.log(`[Wait] 等待页面渲染...`, logger.LOG_LEVELS.INFO);
        await page.waitForTimeout(5000); 

        // 注入我们的智能脚本
        await page.evaluate(INTELLIGENT_READER_SCRIPT);
        
        await handleGuidePopup(page);
        await checkAndClickCookieBanner(page);
        
        // 滚动逻辑
        logger.log(`[Scroll] 滚动加载数据...`, logger.LOG_LEVELS.INFO);
        await page.evaluate(async () => {
            window.scrollTo(0, 1000);
            await new Promise(r => setTimeout(r, 800));
            window.scrollTo(0, 2500); 
            await new Promise(r => setTimeout(r, 800));
            window.scrollTo(0, 0);   
        });
        await page.waitForTimeout(2000);

        logger.log(`[Loop] 开始循环抓取 [${category}]...`, logger.LOG_LEVELS.INFO);

        // --- 主循环 ---
        setInterval(async () => {
            try {
                // 1. 从浏览器内存中“偷”数据
                const rawData = await page.evaluate(() => {
                    // @ts-ignore
                    return window.MemeReader ? window.MemeReader.scan() : null;
                });

                if (rawData && rawData.length > 0) {
                    // 2. 标准化
                    const items = normalizeData(rawData, category);
                    const firstItem = items[0];
                    const time = new Date().toLocaleTimeString();

                    // 3. 发送给后端
                    const socketEventCategory = `meme_${category}`; 
                    
                    socket.emit('data-update', { 
                        category: socketEventCategory, 
                        type: 'full', 
                        data: items 
                    });

                    logger.log(
                        `⚡ ${time} | [${category.padEnd(8)}] | Count: ${items.length} | Top: ${firstItem.symbol} (${firstItem.progress}%)`, 
                        logger.LOG_LEVELS.INFO
                    );
                }

            } catch (err: any) {
                logger.log(`❌ Loop Error: ${err.message}`, logger.LOG_LEVELS.ERROR);
            }
        }, CAPTURE_CONFIG.interval);

        // 保持进程不退出
        await new Promise(() => {});

    } catch (error: any) {
        logger.log(`❌ Setup Error: ${error.message}`, logger.LOG_LEVELS.ERROR);
        throw error;
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
            proxy: { server: CAPTURE_CONFIG.proxy },
            args: ['--start-maximized', '--no-sandbox'],
        });

        await setupMemePage(browser, socket);

    } catch (e: any) {
        logger.log(`❌ Main Error: ${e.stack}`, logger.LOG_LEVELS.ERROR);
    }
}

main();