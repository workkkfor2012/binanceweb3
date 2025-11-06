// extractor.js

// (Final Version v3.5: Concise Symbol-Only Logging)
// 目标：当数据发生变化时，只打印变化的品种symbol列表，避免日志刷屏。

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
const MIN_VOLUME_FILTER = 1;
const EXTRACTION_INTERVAL_MS = 1000;

const SELECTORS = {
  stableContainer: '#__APP div.markets-table',
};

const HEURISTIC_CONFIG = {
  maxFiberTreeDepth: 250,
  minArrayLength: 10,
  requiredKeys: ['symbol', 'price', 'volume24h', 'marketCap', 'priceChange24h'],
};

const DESIRED_FIELDS = [
  'chainId', 'contractAddress', 'symbol', 'icon', 
  'marketCap', 'price', 
  'volume1m', 'volume5m', 'volume1h', 'volume4h', 'volume24h',
  'priceChange1m', 'priceChange5m', 'priceChange1h', 'priceChange4h', 'priceChange24h'
];
// ==============================================================================

async function main() {
  logger.init();
  let browser;
  
  logger.log('🚀 [Diffing Extractor v3.5] 脚本启动...', logger.LOG_LEVELS.INFO);
  
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

    await page.addInitScript({
      content: 'window.originalConsoleLog = console.log;'
    });

    await page.goto('https://web3.binance.com/zh-CN/markets/trending?chain=bsc', { waitUntil: 'load', timeout: 90000 });
    await handleGuidePopup(page);
    await checkAndClickCookieBanner(page);
    await applyVolumeFilter(page, MIN_VOLUME_FILTER);

    logger.log('✅ 页面初始化完成，准备注入智能提取器...', logger.LOG_LEVELS.INFO);

    const handleExtractedData = (result) => {
      const { 
        type, data, path, cacheHit,
        duration, readDuration, diffDuration, 
        totalCount, changedCount 
      } = result;
      
      const cacheStatus = cacheHit ? 'CACHE HIT' : 'CACHE MISS';
      const timeStamp = `[${new Date().toLocaleTimeString()}]`;

      if (type === 'no-change') {
        const perfString = `Read: ${totalCount} items | Total: ${duration}ms (Read: ${readDuration}ms, Diff: ${diffDuration}ms) | ${cacheStatus}`;
        process.stdout.write(`\r${timeStamp} Tick checked. No changes. [Perf: ${perfString}]      `);
        return;
      }

      if (!data || data.length === 0) return;
      
      const updateType = type === 'snapshot' ? '首次快照' : '增量更新';
      const summary = `Read: ${totalCount} | Changed: ${changedCount} | Time -> Total: ${duration}ms (Read: ${readDuration}ms, Diff: ${diffDuration}ms) | ${cacheStatus}`;

      logger.log(`\n========== [ ${updateType} at ${new Date().toLocaleTimeString()} ] ==========`, logger.LOG_LEVELS.INFO);
      logger.log(`   📊 SUMMARY: ${summary}`, logger.LOG_LEVELS.INFO);
      if(path) logger.log(`   📍 SOURCE PATH: ${path}`, logger.LOG_LEVELS.INFO);
      
      // ✨ ================== 核心变更：只打印变化的 Symbol 列表 ==================
      const changedSymbols = data.map(item => item.symbol).join(', ');
      logger.log(`   🔄 CHANGED SYMBOLS: ${changedSymbols}`, logger.LOG_LEVELS.INFO);
      // ✨ =======================================================================
      
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

    logger.log(`\n👍 脚本进入高频变更检测模式 (${EXTRACTION_INTERVAL_MS}ms)。请在浏览器窗口按F12查看高频日志。`, logger.LOG_LEVELS.INFO);
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