// hotlist.js
// (v75: Extraction with Path Reporting)
// 目标：在提取数据的同时，报告数据在内存中的确切路径，以便于调试和维护。

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { handleGuidePopup, checkAndClickCookieBanner } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js');
const logger = require('./logger.js');

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const SCRIPT_DURATION_SECONDS = 180;
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 200;
const EXTRACTION_INTERVAL_MS = 5000;

const SELECTORS = {
  stableContainer: '#__APP div.markets-table',
};

const HEURISTIC_CONFIG = {
  maxFiberTreeDepth: 25,
  minArrayLength: 10,
  requiredKeys: ['symbol', 'price', 'volume24h', 'marketCap', 'priceChange24h'],
};

const DESIRED_FIELDS = ['symbol', 'price', 'volume24h', 'marketCap', 'priceChange24h'];
// ==============================================================================

async function main() {
  logger.init();
  let browser;
  
  logger.log('🚀 [Extractor v75 - Path Reporting] 脚本启动...', logger.LOG_LEVELS.INFO);
  logger.log(`🎯 目标: 提取数据并报告其在内存中的来源路径。`, logger.LOG_LEVELS.INFO);
  
  try {
    browser = await chromium.launch({
      executablePath: MY_CHROME_PATH,
      headless: false,
      proxy: { server: 'socks5://127.0.0.1:1080' },
      args: ['--start-maximized']
    });

    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    await page.goto('https://web3.binance.com/zh-CN/markets/trending?chain=bsc', { waitUntil: 'load', timeout: 90000 });
    await handleGuidePopup(page);
    await checkAndClickCookieBanner(page);
    await applyVolumeFilter(page, MIN_VOLUME_FILTER);

    logger.log('✅ 页面初始化完成，部署带路径报告的提取器...', logger.LOG_LEVELS.INFO);

    // ✨ 核心变更：处理函数现在接收一个包含 data 和 path 的对象
    const handleExtractedData = (result) => {
      const { data, path } = result;
      if (!data || data.length === 0) {
        logger.log('⚠️ [Extractor] 本轮未提取到数据。', logger.LOG_LEVELS.ERROR);
        return;
      }
      
      logger.log(`\n========== [ 数据更新 at ${new Date().toLocaleTimeString()} | 发现 ${data.length} 条记录 ] ==========`, logger.LOG_LEVELS.INFO);
      // 打印数据来源路径
      logger.log(`   📍 SOURCE PATH: ${path}`, logger.LOG_LEVELS.INFO);
      
      const header = DESIRED_FIELDS.map(field => field.padEnd(18)).join('');
      logger.log(header, logger.LOG_LEVELS.INFO);
      logger.log('-'.repeat(header.length), logger.LOG_LEVELS.INFO);

      data.slice(0, 15).forEach(item => {
        const row = DESIRED_FIELDS.map(field => {
          const value = item[field] !== null && item[field] !== undefined ? item[field] : 'N/A';
          return String(value).padEnd(18);
        }).join('');
        logger.log(row, logger.LOG_LEVELS.INFO);
      });
    };
    await page.exposeFunction('onDataExtracted', handleExtractedData);

    // --- 💡【带路径报告的启发式提取器】💡 ---
    logger.log('🤖 [Extractor] 正在注入带路径报告的提取器...', logger.LOG_LEVELS.INFO);
    await page.evaluate(({ selectors, interval, desiredFields, config }) => {
        
        const getReactFiber = (element) => {
            const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
            return element[key];
        };

        const isMarketDataArray = (arr) => {
            if (!Array.isArray(arr) || arr.length < config.minArrayLength) return false;
            const item = arr[0];
            if (typeof item !== 'object' || item === null) return false;
            const keys = Object.keys(item);
            return config.requiredKeys.every(key => keys.includes(key));
        };

        // ✨ 核心变更：深度搜索函数现在返回一个包含数据和路径的对象
        const deepSearchForArray = (obj, path, visited) => {
            if (!obj || typeof obj !== 'object' || visited.has(obj)) {
                return null;
            }
            visited.add(obj);

            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    const value = obj[key];
                    const newPath = `${path}.${key}`;
                    if (isMarketDataArray(value)) {
                        return { data: value, path: newPath }; // 找到了！返回数据和路径
                    }
                    if (typeof value === 'object') {
                        const result = deepSearchForArray(value, newPath, visited);
                        if (result) return result;
                    }
                }
            }
            return null;
        };

        const extractData = () => {
            const targetElement = document.querySelector(selectors.stableContainer);
            if (!targetElement) return;
            let currentFiber = getReactFiber(targetElement);
            if (!currentFiber) return;

            let depth = 0;
            while (currentFiber && depth < config.maxFiberTreeDepth) {
                const fiberPath = 'fiber' + '.return'.repeat(depth);
                
                // ✨ 核心变更：搜索时传入初始路径
                const result = deepSearchForArray(currentFiber.memoizedProps, `${fiberPath}.memoizedProps`, new Set()) || 
                               deepSearchForArray(currentFiber.memoizedState, `${fiberPath}.memoizedState`, new Set());

                if (result) {
                    const { data, path } = result;
                    const filteredData = data.map(item => {
                        const newItem = {};
                        for (const field of desiredFields) {
                            newItem[field] = item[field];
                        }
                        return newItem;
                    });
                    // ✨ 核心变更：将包含数据和路径的对象一起发送
                    window.onDataExtracted({ data: filteredData, path: path });
                    return;
                }
                currentFiber = currentFiber.return;
                depth++;
            }
        };

        setInterval(extractData, interval);
        console.log(`✅ 提取器已启动，每 ${interval}ms 运行一次.`);
        extractData();

    }, { 
        selectors: SELECTORS, 
        interval: EXTRACTION_INTERVAL_MS,
        desiredFields: DESIRED_FIELDS,
        config: HEURISTIC_CONFIG
    });

    logger.log(`\n👍 脚本进入持续提取模式。按 CTRL+C 停止。`, logger.LOG_LEVELS.INFO);
    await new Promise(() => {});

  } catch (error) {
    logger.log(`❌ 脚本执行时发生严重错误: ${error.stack}`, logger.LOG_LEVELS.ERROR);
  } finally {
    if (browser) {
      logger.log('\n🏁 脚本结束，关闭浏览器.', logger.LOG_LEVELS.INFO);
      await browser.close();
    }
    logger.close();
  }
}

main();