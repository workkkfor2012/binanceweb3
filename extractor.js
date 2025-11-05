// extractor.js
// (Final Version v3.1: Expanded Fields)
// 目标：加载实现了变更检测的浏览器脚本，监控并打印一组扩展的字段。

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
const MIN_VOLUME_FILTER = 100;
const EXTRACTION_INTERVAL_MS = 200;

const SELECTORS = {
  stableContainer: '#__APP div.markets-table',
};

const HEURISTIC_CONFIG = {
  maxFiberTreeDepth: 250,
  minArrayLength: 10,
  requiredKeys: ['symbol', 'price', 'volume24h', 'marketCap', 'priceChange24h'],
};

// ✨ 核心变更：在这里添加了5个价格变动字段
const DESIRED_FIELDS = [
  // 基础信息
  'chainId', 'contractAddress', 'symbol', 'icon', 
  // 核心指标
  'marketCap', 'price', 
  // 成交额 (多周期)
  'volume1m', 'volume5m', 'volume1h', 'volume4h', 'volume24h',
  // 价格变动 (多周期)
  'priceChange1m', 'priceChange5m', 'priceChange1h', 'priceChange4h', 'priceChange24h'
];
// ==============================================================================

async function main() {
  logger.init();
  let browser;
  
  logger.log('🚀 [Diffing Extractor v3.1] 脚本启动...', logger.LOG_LEVELS.INFO);
  
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

    const handleExtractedData = (result) => {
      const { data, path, duration, cacheHit, type } = result;
      if (!data || data.length === 0) return;
      
      const cacheStatus = cacheHit ? 'CACHE HIT' : 'CACHE MISS';
      const updateType = type === 'snapshot' ? '首次快照' : '增量更新';

      logger.log(`\n========== [ ${updateType} at ${new Date().toLocaleTimeString()} | ${data.length} 条变更 | ${duration} ms | ${cacheStatus} ] ==========`, logger.LOG_LEVELS.INFO);
      if(path) logger.log(`   📍 SOURCE PATH: ${path}`, logger.LOG_LEVELS.INFO);
      
      data.forEach((item, index) => {
        logger.log(`\n--- Change #${index + 1} | Symbol: ${item.symbol} ---`, logger.LOG_LEVELS.INFO);
        for (const field of DESIRED_FIELDS) {
          const value = item[field] !== null && item[field] !== undefined ? item[field] : 'N/A';
          const fieldNamePadded = field.padEnd(18, ' ');
          logger.log(`   ${fieldNamePadded}: ${value}`, logger.LOG_LEVELS.INFO);
        }
      });
       logger.log('='.repeat(80), logger.LOG_LEVELS.INFO);
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

    logger.log(`\n👍 脚本进入高频变更检测模式 (${EXTRACTION_INTERVAL_MS}ms)。按 CTRL+C 停止。`, logger.LOG_LEVELS.INFO);
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