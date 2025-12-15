// packages/extractor/src/meme-scanner.ts
import { chromium } from 'playwright-extra';
import type { Browser, Page } from 'playwright';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as logger from './logger';

chromium.use(stealth());

const MEME_RUSH_URL = 'https://web3.binance.com/zh-CN/meme-rush?chain=bsc';

/**
 * 🕵️ V10 深度侦探脚本
 * 目标：
 * 1. 找到含有 token 列表的数据源
 * 2. 打印出该数据源中单个对象的所有字段（寻找 status/migrated 标志）
 * 3. 分析该列表的排序规则（时间倒序？进度倒序？）
 */
const DEEP_DETECTIVE_SCRIPT = `
(() => {
    console.log('🕵️ [Scanner V10] 启动深度结构分析...');

    const results = new Map();
    const visitedFibers = new WeakSet();

    // --- 辅助：获取 React Fiber ---
    const getReactFiber = (el) => {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
    };

    // --- 辅助：判断是否为 Token 列表 ---
    const isValidTokenList = (list) => {
        if (!Array.isArray(list) || list.length < 2) return false;
        const first = list[0];
        // 必须是对象
        if (!first || typeof first !== 'object') return false;
        
        // 必须包含关键特征字段
        const keys = Object.keys(first).join(',').toLowerCase();
        const hasIdentity = (first.symbol || first.name);
        const hasAddress = keys.includes('address') || keys.includes('contract');
        
        return hasIdentity && hasAddress;
    };

    // --- 辅助：分析排序趋势 ---
    const analyzeTrend = (list, field) => {
        if (list.length < 2) return 'N/A';
        const sample = list.slice(0, 10);
        let ascending = true;
        let descending = true;

        for (let i = 0; i < sample.length - 1; i++) {
            const a = sample[i][field] || 0;
            const b = sample[i+1][field] || 0;
            if (a > b) ascending = false;
            if (a < b) descending = false;
        }

        if (ascending && !descending) return 'Ascending (⬆️)';
        if (descending && !ascending) return 'Descending (⬇️)';
        return 'Random/Mixed';
    };

    // --- 辅助：提取所有字段结构 ---
    const inspectObjectStructure = (obj) => {
        const info = {};
        Object.keys(obj).forEach(k => {
            const v = obj[k];
            if (typeof v === 'object' && v !== null) {
                info[k] = Array.isArray(v) ? \`Array(\${v.length})\` : 'Object';
            } else {
                // 截断过长的字符串
                let strVal = String(v);
                if (strVal.length > 50) strVal = strVal.substring(0, 50) + '...';
                info[k] = strVal;
            }
        });
        return info;
    };

    // --- 主扫描循环 ---
    const allElements = document.querySelectorAll('div, span, section, main, ul, li');
    console.log(\`[Scanner] Scanning \${allElements.length} elements...\`);

    allElements.forEach(el => {
        let fiber = getReactFiber(el);
        let depth = 0;
        const MAX_CLIMB = 50; 

        while (fiber && depth < MAX_CLIMB) {
            if (visitedFibers.has(fiber)) {
                fiber = fiber.return;
                depth++;
                continue;
            }
            visitedFibers.add(fiber);

            const sources = [
                { name: 'Props', data: fiber.memoizedProps },
                { name: 'Props.Value', data: fiber.memoizedProps?.value }, // Context
                { name: 'State', data: fiber.memoizedState },
            ];

            sources.forEach(src => {
                if (!src.data || typeof src.data !== 'object') return;

                Object.keys(src.data).forEach(propKey => {
                    const val = src.data[propKey];
                    
                    if (isValidTokenList(val)) {
                        // 生成唯一指纹：Symbol_Length_PropKey
                        const first = val[0];
                        const fingerprint = \`\${first.symbol}_\${val.length}_\${propKey}\`;

                        if (!results.has(fingerprint)) {
                            // 🚀 核心：深度分析
                            results.set(fingerprint, {
                                location: \`\${src.name} -> \${propKey}\`,
                                count: val.length,
                                // 1. 结构透视：拿第一个数据看所有字段
                                structure: inspectObjectStructure(first),
                                // 2. 趋势分析
                                trends: {
                                    time: analyzeTrend(val, 'createTime') !== 'N/A' ? analyzeTrend(val, 'createTime') : analyzeTrend(val, 'startTime'),
                                    progress: analyzeTrend(val, 'progress'),
                                    marketCap: analyzeTrend(val, 'marketCap')
                                },
                                // 3. 预览数据
                                preview: val.slice(0, 3).map(i => ({
                                    symbol: i.symbol,
                                    progress: i.progress,
                                    status: i.status || i.state || 'N/A', // 尝试猜测 status 字段
                                    time: i.createTime || i.startTime || 0
                                }))
                            });
                        }
                    }
                });
            });

            fiber = fiber.return;
            depth++;
        }
    });

    return Array.from(results.values());
})();
`;

/**
 * 🕵️ 简易监控脚本 (每5秒运行)
 * 目标：
 * 1. 快速扫描列表
 * 2. 返回【数量】和【前5个币名】
 */
const PERIODIC_MONITOR_SCRIPT = `
(() => {
    const results = [];
    const visitedFibers = new WeakSet();

    const getReactFiber = (el) => {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        return key ? el[key] : null;
    };

    const isValidTokenList = (list) => {
        if (!Array.isArray(list) || list.length < 2) return false;
        const first = list[0];
        if (!first || typeof first !== 'object') return false;
        return (first.symbol || first.name) && (Object.keys(first).some(k => k.toLowerCase().includes('addr')));
    };

    const allElements = document.querySelectorAll('div, span, section, main, ul, li');
    
    allElements.forEach(el => {
        let fiber = getReactFiber(el);
        let depth = 0;
        const MAX_CLIMB = 50; 

        while (fiber && depth < MAX_CLIMB) {
            if (visitedFibers.has(fiber)) {
                fiber = fiber.return;
                depth++;
                continue;
            }
            visitedFibers.add(fiber);

            const sources = [
                { name: 'Props', data: fiber.memoizedProps },
                { name: 'Props.Value', data: fiber.memoizedProps?.value },
                { name: 'State', data: fiber.memoizedState }
            ];

            sources.forEach(src => {
                if (!src.data || typeof src.data !== 'object') return;

                Object.keys(src.data).forEach(propKey => {
                    const val = src.data[propKey];
                    if (isValidTokenList(val)) {
                        const first = val[0];
                        results.push({
                            source: \`\${src.name} -> \${propKey}\`,
                            depth: depth,
                            count: val.length,
                            // 完整对象，用于展示所有字段
                            firstItemFull: first,
                            // 前5个元素的检查
                            top5: val.slice(0, 5).map(t => ({
                                symbol: t.symbol,
                                migrateStatus: t.migrateStatus
                            }))
                        });
                    }
                });
            });

            fiber = fiber.return;
            depth++;
        }
    });

    // 不去重，直接返回所有发现的列表，按 count 排序
    return results.sort((a, b) => b.count - a.count);
})();
`;

async function scanMemePage() {
    logger.init();
    logger.log(`🕵️ [MemeScanner V10] 启动全字段深度扫描`, logger.LOG_LEVELS.INFO);

    // 显式指定类型 Browser
    const browser: Browser = await chromium.launch({
        headless: false, // 必须开启 UI 以便 React 加载
        args: ['--start-maximized'],
        proxy: { server: 'socks5://127.0.0.1:1080' } // 保持代理
    });

    try {
        const context = await browser.newContext({ viewport: null });
        // 显式指定类型 Page
        const page: Page = await context.newPage();

        // 劫持 console 以便调试
        await page.addInitScript(() => {
            (window as any).__logs = [];
            const originalLog = console.log;
            console.log = (...args) => {
                (window as any).__logs.push(args.join(' '));
                originalLog.apply(console, args);
            };
        });

        logger.log(`[Navi] 前往目标页面: ${MEME_RUSH_URL}`, logger.LOG_LEVELS.INFO);
        await page.goto(MEME_RUSH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        logger.log(`[Wait] 等待数据流加载 (10秒)...`, logger.LOG_LEVELS.INFO);
        // 稍微乱动一下鼠标，触发一些 hover 状态可能加载的数据
        await page.mouse.move(100, 100);
        await page.mouse.move(500, 500);
        await page.waitForTimeout(10000);

        // 滚动到底部再回来，触发 lazy load
        logger.log(`[Scroll] 触发页面滚动...`, logger.LOG_LEVELS.INFO);
        await page.evaluate(async () => {
            const steps = [1000, 2000, 3000, 0];
            for (const y of steps) {
                window.scrollTo(0, y);
                await new Promise(r => setTimeout(r, 800));
            }
        });
        await page.waitForTimeout(2000);

        // 执行注入脚本
        logger.log(`[Inject] 执行 V10 分析脚本...`, logger.LOG_LEVELS.INFO);
        const results: any[] = await page.evaluate(DEEP_DETECTIVE_SCRIPT);

        if (!results || results.length === 0) {
            logger.log(`❌ 未发现任何列表数据。可能页面结构已变或反爬。`, logger.LOG_LEVELS.ERROR);
        } else {
            logger.log(`\n🎉 扫描成功! 发现了 ${results.length} 个候选列表。\n`, logger.LOG_LEVELS.INFO);

            // 按列表长度排序（通常主列表最长）
            results.sort((a, b) => b.count - a.count);

            results.forEach((res, idx) => {
                console.log(`\n===============================================================`);
                console.log(`📦 [LIST #${idx + 1}] source: ${res.location} | Count: ${res.count}`);
                console.log(`===============================================================`);

                console.log(`📊 [SORTING TRENDS] (这决定了谁在队列最上面)`);
                console.log(`   Time:     ${res.trends.time}`);
                console.log(`   Progress: ${res.trends.progress}`);
                console.log(`   MktCap:   ${res.trends.marketCap}`);

                console.log(`\n🔍 [OBJECT INSPECTION] (第一个币的所有字段 - 寻找 status/migrated 标志)`);
                console.table(res.structure);

                console.log(`\n👀 [PREVIEW] (前 3 个数据)`);
                res.preview.forEach((p: any) => {
                    console.log(`   - ${p.symbol.padEnd(8)} | Prog: ${p.progress}% | Status: ${p.status} | Time: ${p.time}`);
                });
            });

            console.log(`\n💡 [分析建议]`);
            console.log(`1. 查看 "OBJECT INSPECTION" 表格。`);
            console.log(`2. 寻找类似 'listingStatus', 'state', 'phase', 'isDex' 这样的字段。`);
            console.log(`3. 比较 [LIST #1] 和 [LIST #2] (如果有)，通常一个是 'New' 一个是 'Migrated'。`);
            console.log(`4. 确认 'Time' 的排序趋势：如果 Time 是 Descending (⬇️)，则数组第 0 个就是最新的。`);

            logger.log(`\n[Loop] 进入5秒轮询模式... 按 Ctrl+C 停止`, logger.LOG_LEVELS.INFO);

            // 下面开始死循环监控
            while (true) {
                await page.waitForTimeout(5000); // 5秒

                try {
                    const periodicResults: any[] = await page.evaluate(PERIODIC_MONITOR_SCRIPT);

                    if (periodicResults && periodicResults.length > 0) {
                        const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
                        console.log(`\n[${timeStr}] 🔍 Deep Probe Report -------------------------`);

                        periodicResults.forEach((list, idx) => {
                            if (list.count < 5) return; // Ignore small noise

                            console.log(`📦 [List #${idx + 1}] Source: ${list.source} (Depth: ${list.depth}) | Count: ${list.count}`);

                            // 打印前5个的一致性
                            const top5Str = list.top5.map((t: any) => `${t.symbol}(${t.migrateStatus})`).join(', ');
                            console.log(`   Top 5: ${top5Str}`);

                            // 打印第一个元素的关键字段概览 (Key-Value)
                            // 为了不刷屏，只打印几个关键的 + 所有 key names
                            const f = list.firstItemFull;
                            const keys = Object.keys(f);
                            console.log(`   First Item Keys (${keys.length}): ${keys.join(', ')}`);
                            console.log(`   First Item Sample:`);
                            console.log(`     - symbol: ${f.symbol}`);
                            console.log(`     - migrateStatus: ${f.migrateStatus}`);
                            console.log(`     - progress: ${f.progress}`);
                            console.log(`     - createTime: ${f.createTime}`);
                            console.log(`     - migrateTime: ${f.migrateTime}`);

                            console.log(`   --------------------------------------------------`);
                        });
                    }
                } catch (err: any) {
                    console.error('[Monitor Error]', err.message);
                }
            }
        }

    } catch (e: any) {
        logger.log(`❌ Error: ${e.message}`, logger.LOG_LEVELS.ERROR);
    } finally {
        // 保持浏览器开启一会以便人工检查，如果需要关闭请取消注释
        // await browser.close();
        // logger.close(); // 死循环模式下，只有报错才会走到这里，或者手动关闭。先注释掉以免过早关闭
    }
}

scanMemePage();