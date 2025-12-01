// packages/extractor/src/meme-scanner.ts
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as logger from './logger';


chromium.use(stealth());

const MEME_RUSH_URL = 'https://web3.binance.com/zh-CN/meme-rush?chain=bsc';

const DEEP_DUMP_SCRIPT = `
(() => {
console.log('🕵️ [Scanner V9] 启动全链路爬升扫描...');

const results = new Map(); // Key: 第一条数据的合约地址 (去重用)
const visitedFibers = new WeakSet(); // 性能优化：避免重复扫描同一个父组件

// --- 辅助函数 ---
const getReactFiber = (el) => {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    return key ? el[key] : null;
};

const isValidTokenList = (list) => {
    if (!Array.isArray(list) || list.length < 2) return false;
    const first = list[0];
    // 宽松匹配：只要有 symbol 且有某种 address 字段
    return first && typeof first === 'object' && 
           (first.symbol || first.name) && 
           (Object.keys(first).some(k => k.toLowerCase().includes('address') || k === 'contract'));
};

// --- 主逻辑 ---
// 1. 获取所有可能包含数据的 DOM 节点
const allElements = document.querySelectorAll('div, span, section, main');

console.log(\`Found \${allElements.length} DOM elements. Climbing trees...\`);

allElements.forEach(el => {
    let fiber = getReactFiber(el);
    let depth = 0;
    const MAX_CLIMB = 80; // 爬高点

    while (fiber && depth < MAX_CLIMB) {
        // 优化：如果这个组件已经被扫描过，就不用再扫了
        // 因为同一个组件是许多子元素的共同父级
        if (visitedFibers.has(fiber)) {
            fiber = fiber.return;
            depth++;
            continue;
        }
        visitedFibers.add(fiber);

        // 检查 props 和 state
        const candidates = [
            fiber.memoizedProps,
            fiber.memoizedProps?.value, // Context Provider value
            fiber.memoizedState,
            fiber.memoizedState?.memoizedState // Hooks
        ];

        candidates.forEach(source => {
            if (!source || typeof source !== 'object') return;

            // 遍历所有 key
            Object.keys(source).forEach(key => {
                const val = source[key];
                
                if (isValidTokenList(val)) {
                    const firstItem = val[0];
                    // 生成指纹：Symbol + Address + ListLength
                    // 加入 Length 是为了区分“全部列表”和“当前页列表”
                    const fingerprint = \`\${firstItem.symbol}_\${firstItem.contractAddress || 'NA'}_\${val.length}\`;
                    
                    if (!results.has(fingerprint)) {
                        results.set(fingerprint, {
                            location: key, // 属性名 (allTokens, currentTokens 等)
                            length: val.length,
                            // 提取前 5 个用于人工核对
                            preview: val.slice(0, 5).map(item => ({
                                name: item.name,
                                symbol: item.symbol,
                                progress: item.progress,
                                status: item.status,
                                // 格式化时间
                                time: item.startTime ? new Date(item.startTime).toLocaleString() : 
                                      (item.createTime ? new Date(item.createTime).toLocaleString() : 'N/A')
                            }))
                        });
                    }
                }
            });
        });

        fiber = fiber.return; // 继续向上爬
        depth++;
    }
});

// 转换 Map 为数组返回
window.__V9_RESULTS__ = Array.from(results.values());

})();
`;

async function scanMemePage() {
    logger.init();
    // 注意：原代码此处缺少引号，已修复为反引号字符串
    logger.log(`🕵️ [MemeScanner V9] 启动全链路爬升扫描: ${MEME_RUSH_URL}`, logger.LOG_LEVELS.INFO);

    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized'],
        // ✨ 代理配置
        proxy: { server: 'socks5://127.0.0.1:1080' } 
    });

    try {
        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();
        
        await page.addInitScript({
            content: `window.originalConsoleLog = console.log; console.log = (...args) => window.originalConsoleLog(...args);`
        });

        logger.log(`[Navi] 访问页面...`, logger.LOG_LEVELS.INFO);
        await page.goto(MEME_RUSH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        logger.log(`[Wait] 等待加载 (10s)...`, logger.LOG_LEVELS.INFO);
        await page.waitForTimeout(10000); 

        // 强力滚动
        logger.log(`[Scroll] 滚动加载所有板块...`, logger.LOG_LEVELS.INFO);
        await page.evaluate(async () => {
            window.scrollTo(0, 1000);
            await new Promise(r => setTimeout(r, 1000));
            window.scrollTo(0, 2000); 
            await new Promise(r => setTimeout(r, 1000));
            window.scrollTo(0, 3000); // 确保已迁移到底部
            await new Promise(r => setTimeout(r, 1000));
            window.scrollTo(0, 0);
        });
        await page.waitForTimeout(3000);

        logger.log(`[Inject] 执行 V9 扫描...`, logger.LOG_LEVELS.INFO);
        await page.evaluate(DEEP_DUMP_SCRIPT);

        const results: any[] = await page.evaluate(() => (window as any).__V9_RESULTS__);

        if (!results || results.length === 0) {
            logger.log(`❌ 依然未找到。这极不正常，请检查页面是否为空白。`, logger.LOG_LEVELS.ERROR);
        } else {
            logger.log(`\n🎉 扫描完成! 发现了 ${results.length} 个不同的数据列表。\n`, logger.LOG_LEVELS.INFO);
            
            console.log('===============================================================');
            console.log('                 MemeScanner V9 - DATA INSPECTION              ');
            console.log('===============================================================');
            
            // 按长度排序，长列表通常更有价值
            results.sort((a, b) => b.length - a.length);

            results.forEach((res, index) => {
                console.log(`\n📦 [List #${index + 1}] Found key: "${res.location}" | Count: ${res.length}`);
                console.log(`----------------------------------------------------------------------------------`);
                // 使用 console.table 在终端可能显示不全，手动格式化打印
                console.log(`| Symbol       | Name            | Prog   | Status   | Time`);
                console.log(`|--------------|-----------------|--------|----------|-----------------------`);
                res.preview.forEach((p: any) => {
                    const name = (p.name || '').substring(0, 15).padEnd(15);
                    const sym = (p.symbol || '').substring(0, 12).padEnd(12);
                    const prog = (p.progress !== undefined ? p.progress + '%' : 'N/A').padEnd(6);
                    const stat = (p.status || 'N/A').padEnd(8);
                    const time = p.time;
                    console.log(`| ${sym} | ${name} | ${prog} | ${stat} | ${time}`);
                });
            });

            console.log('\n===============================================================');
            console.log('💡 决策时刻:');
            console.log('   请截图告诉我，哪个列表是【即将发行】（看 Time 是未来的），哪个是【已迁移】（看 Prog 是 100%）。');
        }

    } catch (e: any) {
        logger.log(`❌ Error: ${e.message}`, logger.LOG_LEVELS.ERROR);
    } finally {
        logger.close();
    }
}

scanMemePage();