// extractor.js
// (Final Version v2.1: Displaying Performance Timings)
// 目标：加载外部浏览器脚本，并显示每次提取的耗时及缓存命中状态。

const fs = require('fs').promises;
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { handleGuidePopup, checkAndClickCookieBanner } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js');
const logger = require('./logger.js');

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 200;
const EXTRACTION_INTERVAL_MS = 100;

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
  
  logger.log('🚀 [Cached Extractor v2.1] 脚本启动...', logger.LOG_LEVELS.INFO);
  
  try {
    const browserScript = await fs.readFile(path.join(__dirname, 'browser-script.js'), 'utf-8');

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

    logger.log('✅ 页面初始化完成，准备注入智能提取器...', logger.LOG_LEVELS.INFO);

    // ✨ 核心变更：处理函数现在接收包含性能信息的结果
    const handleExtractedData = (result) => {
      const { data, path, duration, cacheHit } = result;
      if (!data || data.length === 0) return;
      
      const cacheStatus = cacheHit ? 'CACHE HIT' : 'CACHE MISS (SEARCH)';
      logger.log(`\n========== [ 数据更新 at ${new Date().toLocaleTimeString()} | ${data.length} 条 | ${duration} ms | ${cacheStatus} ] ==========`, logger.LOG_LEVELS.INFO);
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

    await page.evaluate(`
      ${browserScript}
      initializeExtractor(${JSON.stringify({
        selectors: SELECTORS,
        interval: EXTRACTION_INTERVAL_MS,
        desiredFields: DESIRED_FIELDS,
        config: HEURISTIC_CONFIG
      })});
    `);

    logger.log(`\n👍 脚本进入高频提取模式 (${EXTRACTION_INTERVAL_MS}ms)。按 CTRL+C 停止。`, logger.LOG_LEVELS.INFO);
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