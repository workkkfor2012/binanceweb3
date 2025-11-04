// hotlist.js
// (v50: 最终版 - 回归极致简单，采用经验证的高频纯轮询方案)

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { handleGuidePopup, checkAndClickCookieBanner } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js'); // 必须是 v29 版本
const { log } = require('./logger.js');

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const SCRIPT_DURATION_SECONDS = 180;
const POLLING_INTERVAL_MS = 200; // 激进的200毫秒轮询间隔
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 200;

const SELECTORS = {
  rows:           'div.markets-table > table > tbody > tr', 
  symbol:         'td:nth-child(1) .shrink-0.t-subtitle1',
  price:          'td:nth-child(4) .t-caption1.text-\\[--color-PrimaryText\\]',
  volume1h:       'td:nth-child(7) .text-\\[--color-PrimaryYellow\\]',
  change1h:       'td:nth-child(5) a span',
};
// ==============================================================================

/**
 * 在浏览器页面上执行的函数，用于抓取所有可见行的数据。
 */
function scrapeDataInBrowser(selectors) {
  const rows = Array.from(document.querySelectorAll(selectors.rows));
  const results = [];
  for (const rowElement of rows) {
    try {
      const data = {};
      const dataSelectors = { ...selectors };
      delete dataSelectors.rows;
      for (const key in dataSelectors) {
        const cell = rowElement.querySelector(dataSelectors[key]);
        data[key] = cell ? cell.textContent.trim() : null;
      }
      if (data.symbol) {
        results.push(data);
      }
    } catch (e) {}
  }
  return results;
}


async function main() {
  let browser;
  let pollingInterval;
  log('🚀 [High-Freq Polling v50] 最终版脚本启动...');
  try {
    browser = await chromium.launch({ 
      executablePath: MY_CHROME_PATH, 
      headless: false, 
      proxy: { server: 'socks5://127.0.0.1:1080' },
      args: ['--start-maximized']
    });
    
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    const targetUrl = 'https://web3.binance.com/zh-CN/markets/trending?chain=bsc';
    log(`🧭 正在导航到: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 90000 });

    await handleGuidePopup(page);
    await checkAndClickCookieBanner(page);
    log('✅ 所有弹窗已清理完毕，页面就绪。');

    await applyVolumeFilter(page, MIN_VOLUME_FILTER);

    let lastDataState = '';
    let isFirstRun = true;

    pollingInterval = setInterval(async () => {
      try {
        const startTime = performance.now(); // Node.js 端计时
        const currentData = await page.evaluate(scrapeDataInBrowser, SELECTORS);
        const endTime = performance.now();
        const duration = endTime - startTime;
        
        const currentState = JSON.stringify(currentData);
        
        if (currentState !== lastDataState && currentData.length > 0) {
          log(`\n[⚡️ DATA REFRESH - ${new Date().toLocaleTimeString()} | Took ${duration.toFixed(2)}ms]`);
          currentData.forEach(item => {
            log(
              `  [${(item.symbol || 'N/A').padEnd(8)}] ` +
              `价格: ${(item.price || 'N/A').padEnd(10)} | ` +
              `1h成交额: ${(item.volume1h || 'N/A').padEnd(10)} | ` +
              `1h涨跌: ${item.change1h || 'N/A'}`
            );
          });
          lastDataState = currentState;
        } else if (isFirstRun && currentData.length > 0) {
          // 确保第一次运行时即使数据不变也能打印
          log(`\n[✅ INITIAL DATA - ${new Date().toLocaleTimeString()} | Took ${duration.toFixed(2)}ms]`);
          currentData.forEach(item => {log(/* ... */);});
          lastDataState = currentState;
          isFirstRun = false;
        }

      } catch (e) {
        // 在高频轮询中，偶尔的错误可以被容忍和忽略
        // log(`- [Polling Error] ${e.message}`);
      }
    }, POLLING_INTERVAL_MS);

    log(`\n✨ 高频轮询已启动 (每 ${POLLING_INTERVAL_MS}ms 一次). (将运行 ${SCRIPT_DURATION_SECONDS} 秒)`);
    await new Promise(resolve => setTimeout(resolve, SCRIPT_DURATION_SECONDS * 1000));

  } catch (error) {
    log(`❌ 脚本执行时发生错误: ${error.stack}`); 
  } finally {
    if (pollingInterval) clearInterval(pollingInterval);
    if (browser) {
      log('\n🏁 脚本结束，关闭浏览器.');
      await browser.close();
    }
  }
}

main();