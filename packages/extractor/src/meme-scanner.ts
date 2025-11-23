// packages/extractor/src/meme-scanner.ts
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import * as logger from './logger';

chromium.use(stealth());

const MEME_RUSH_URL = 'https://web3.binance.com/zh-CN/meme-rush?chain=bsc';

const ANCHOR_SCAN_SCRIPT = `
(() => {
    const results = [];
    
    // 辅助：获取 DOM 元素的 React Fiber
    const getReactFiber = (element) => {
        const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
        return key ? element[key] : null;
    };

    // 辅助：判断一个对象是否是我们想要的“市场数据列表”
    const isTargetDataArray = (arr) => {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        const item = arr[0];
        if (!item || typeof item !== 'object') return false;
        
        // 检查是否包含关键金融字段 (大小写不敏感)
        const keys = Object.keys(item).join(',').toLowerCase();
        // 必须包含 price 或 address 或 symbol，且不能全是 react 内部属性
        return (keys.includes('price') || keys.includes('address') || keys.includes('symbol')) 
               && !keys.includes('$$typeof');
    };

    console.log('🕵️ [AnchorScan] 开始基于 DOM 锚点的反向搜索...');

    // 1. 寻找锚点元素
    // 我们寻找包含 "TX" (交易次数) 文本的元素，因为截图显示每张卡片都有 "TX"
    // 或者寻找包含 "%" 的元素
    const allDivs = document.querySelectorAll('div, span');
    let anchorElements = [];
    
    allDivs.forEach(el => {
        // 筛选条件：看起来像是列表里的具体的数值或标签
        if (el.innerText && (el.innerText.includes('TX') || el.innerText.includes('MC'))) {
            anchorElements.push(el);
        }
    });

    // 如果找不到 TX，尝试找任意一个看起来像列表容器的子元素
    if (anchorElements.length === 0) {
        console.log('⚠️ 未找到 "TX" 锚点，尝试使用主要容器的子元素...');
        const container = document.querySelector('.markets-table') || document.querySelector('#__APP');
        if (container && container.children.length > 0) {
            anchorElements.push(container.children[0]);
        }
    }

    console.log(\`Found \${anchorElements.length} potential anchor elements.\`);

    // 2. 向上爬升并检查数据
    const foundPathSet = new Set();

    anchorElements.slice(0, 5).forEach((el, idx) => {
        let fiber = getReactFiber(el);
        let depth = 0;
        const maxClimb = 50; // 向上爬 50 层够不够？

        while (fiber && depth < maxClimb) {
            const checkSource = [
                { name: 'memoizedProps', val: fiber.memoizedProps },
                { name: 'memoizedState', val: fiber.memoizedState }
            ];

            checkSource.forEach(src => {
                if (!src.val || typeof src.val !== 'object') return;

                // 遍历 Props/State 的每一个 key
                Object.keys(src.val).forEach(key => {
                    const value = src.val[key];
                    
                    // 情况 A: 直接是数组
                    if (isTargetDataArray(value)) {
                        const pathId = \`Depth-\${depth}.\${src.name}.\${key}\`;
                        if (!foundPathSet.has(pathId)) {
                            foundPathSet.add(pathId);
                            results.push({
                                source: 'Direct',
                                depth: depth,
                                location: src.name,
                                key: key,
                                length: value.length,
                                sampleKeys: Object.keys(value[0])
                            });
                        }
                    }
                    
                    // 情况 B: 数组被包了一层对象 (例如 data: { list: [...] })
                    if (value && typeof value === 'object' && !Array.isArray(value)) {
                         Object.keys(value).forEach(subKey => {
                             // 跳过 react 内部大对象
                             if (subKey === 'children' || subKey.startsWith('_')) return;
                             
                             const subValue = value[subKey];
                             if (isTargetDataArray(subValue)) {
                                const pathId = \`Depth-\${depth}.\${src.name}.\${key}.\${subKey}\`;
                                if (!foundPathSet.has(pathId)) {
                                    foundPathSet.add(pathId);
                                    results.push({
                                        source: 'Nested',
                                        depth: depth,
                                        location: src.name,
                                        parentKey: key,
                                        key: subKey,
                                        length: subValue.length,
                                        sampleKeys: Object.keys(subValue[0])
                                    });
                                }
                             }
                         });
                    }
                });
            });

            fiber = fiber.return; // 向上爬一级
            depth++;
        }
    });

    window.__ANCHOR_RESULTS__ = results;
    console.log(\`✅ Anchor Scan Complete. Found \${results.length} potential sources.\`);
})();
`;

async function scanMemePage() {
    logger.init();
    logger.log(`🕵️ [MemeScanner V2] 启动反向溯源扫描: ${MEME_RUSH_URL}`, logger.LOG_LEVELS.INFO);

    const browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized'],
        proxy: { server: 'socks5://127.0.0.1:1080' }
    });

    try {
        const context = await browser.newContext({ viewport: null });
        const page = await context.newPage();
        
        await page.addInitScript({
            content: `
                window.originalConsoleLog = console.log;
                console.log = (...args) => window.originalConsoleLog(...args);
            `
        });

        logger.log(`[Navi] 访问页面...`, logger.LOG_LEVELS.INFO);
        await page.goto(MEME_RUSH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 等待数据渲染
        logger.log(`[Wait] 等待页面渲染 (10s)...`, logger.LOG_LEVELS.INFO);
        await page.waitForTimeout(10000); 

        // 尝试滚动一下，确保懒加载的数据出现
        await page.evaluate(() => window.scrollTo(0, 500));
        await page.waitForTimeout(2000);

        logger.log(`[Inject] 执行锚点扫描...`, logger.LOG_LEVELS.INFO);
        await page.evaluate(ANCHOR_SCAN_SCRIPT);

        const results: any[] = await page.evaluate(() => (window as any).__ANCHOR_RESULTS__);

        if (!results || results.length === 0) {
            logger.log(`❌ 反向扫描也未找到数据。可能原因：Canvas 渲染 / ShadowDOM 封闭 / 数据经过了严重的混淆加密。`, logger.LOG_LEVELS.ERROR);
        } else {
            logger.log(`\n🎉 成功! 找到了 ${results.length} 个数据源挂载点。\n`, logger.LOG_LEVELS.INFO);
            
            console.log('===============================================================');
            console.log('                 FOUND DATA SOURCES (Bottom-Up)                ');
            console.log('===============================================================');
            
            results.forEach((res, index) => {
                console.log(`\n[${index + 1}] Depth: ${res.depth} (向上爬了 ${res.depth} 层组件)`);
                if (res.source === 'Direct') {
                    console.log(`    Location: fiber.${res.location}.${res.key}`);
                } else {
                    console.log(`    Location: fiber.${res.location}.${res.parentKey}.${res.key}`);
                }
                console.log(`    Length:   ${res.length}`);
                console.log(`    Sample Keys: [${res.sampleKeys.slice(0, 15).join(', ')}]`);
            });

            console.log('\n===============================================================');
            console.log('💡 提示：选择 Keys 最丰富、Length 最符合预期的那个 Location。');
            console.log('   例如，如果看到有 "newListingData", "upcomingData" 等字段，那就是它了！');
        }

    } catch (e: any) {
        logger.log(`❌ Error: ${e.message}`, logger.LOG_LEVELS.ERROR);
    } finally {
        logger.close();
    }
}

scanMemePage();