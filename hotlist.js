// hotlist.js
// (v63: 终极版 - Node.js可靠驱动 + 浏览器高效批处理)

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { handleGuidePopup, checkAndClickCookieBanner } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js');
const { log } = require('./logger.js');

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const SCRIPT_DURATION_SECONDS = 180;
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 200;
const JIGGLE_INTERVAL_MS = 200;
const CALLBACK_BATCH_DEBOUNCE_MS = 50;

const SELECTORS = {
  stableContainer: '#__APP div.markets-table', 
  symbol:         'td:nth-child(1) .shrink-0.t-subtitle1',
  price:          'td:nth-child(4) .t-caption1.text-\\[--color-PrimaryText\\]',
  volume1h:       'td:nth-child(7) .text-\\[--color-PrimaryYellow\\]',
  change1h:       'td:nth-child(5) a span',
};
// ==============================================================================

function scrapeAllDataInBrowser(selectors) {
    // ... (代码不变)
    const rows = Array.from(document.querySelectorAll(selectors.stableContainer + ' table tbody tr'));
    const results = [];
    for (const rowElement of rows) {
        try {
            const data = {};
            const cellSelectors = { ...selectors };
            delete cellSelectors.stableContainer;
            for (const key in cellSelectors) {
                const cell = rowElement.querySelector(cellSelectors[key]);
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
  let isJigglerActive = true;
  log(`🚀 [Observer v63 - Robust Driver & Batch Callback] 脚本启动...`);
  try {
    browser = await chromium.launch({ 
      executablePath: MY_CHROME_PATH, 
      headless: true, 
      proxy: { server: 'socks5://127.0.0.1:1080' },
      args: ['--start-maximized']
    });
    
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    await page.goto('https://web3.binance.com/zh-CN/markets/trending?chain=bsc', { waitUntil: 'load', timeout: 90000 });
    await handleGuidePopup(page);
    await checkAndClickCookieBanner(page);
    await applyVolumeFilter(page, MIN_VOLUME_FILTER);
    
    // --- 核心优化: 采用悬浮激活，而非滚动 ---
    log('🖱️ [Activation] 正在悬浮表格以激活所有行的实时更新...');
    const tableContainerLocator = page.locator(SELECTORS.stableContainer);
    await tableContainerLocator.hover(); // 模拟鼠标悬停
    await page.mouse.move(0, 0);         // 立即移开，完成一次完整的“进出”
    await page.waitForTimeout(500);      // 等待前端响应
    log('  ✅ 所有可见行应已被激活。');

    const handleRowsUpdate = (updatedRows) => {
      // ... (代码不变)
      if (!updatedRows || updatedRows.length === 0) return;
      log(`\n[⚡️ BATCH REFRESH - ${new Date().toLocaleTimeString()} | ${updatedRows.length} rows updated]`);
      for (const row of updatedRows) {
        if (!row.data) continue;
        log(
            `  🔄 [${(row.data.symbol || 'N/A').padEnd(8)}] ` +
            `价格: ${(row.data.price || 'N/A').padEnd(10)} | ` +
            `1h成交额: ${(row.data.volume1h || 'N.A').padEnd(10)} | ` +
            `1h涨跌: ${(row.data.change1h || 'N/A').padEnd(8)} | ` +
            `(耗时: ${row.duration}ms)`
        );
      }
    };
    await page.exposeFunction('onRowsUpdated', handleRowsUpdate);

    // --- 核心回归: 浏览器端只负责监听和批处理，不再自治抖动 ---
    await page.evaluate(({ selectors, batchDebounce }) => {
      const stableContainer = document.querySelector(selectors.stableContainer);
      if (!stableContainer) { console.error(`[Observer] 致命错误: 无法找到根容器: ${selectors.stableContainer}`); return; }

      let batch = [];
      let debounceTimeout = null;
      const scrapeSingleRow = (rowElement) => {
        try {
          const data = {};
          const cellSelectors = { ...selectors };
          delete cellSelectors.stableContainer;
          for (const key in cellSelectors) {
            const cell = rowElement.querySelector(cellSelectors[key]);
            data[key] = cell ? cell.textContent.trim() : null;
          }
          return data.symbol ? data : null;
        } catch (e) { return null; }
      };
      const robustObserver = new MutationObserver((mutationsList) => {
        const startTime = performance.now();
        const rowsToUpdate = new Set();
        for (const mutation of mutationsList) {
          const targetRow = mutation.target.closest('tr');
          if (targetRow && stableContainer.contains(targetRow)) rowsToUpdate.add(targetRow);
        }
        rowsToUpdate.forEach(rowElement => {
          const rowData = scrapeSingleRow(rowElement);
          if (rowData) {
            batch.push({ data: rowData, duration: (performance.now() - startTime).toFixed(2) });
          }
        });
        if (rowsToUpdate.size > 0) {
          clearTimeout(debounceTimeout);
          debounceTimeout = setTimeout(() => {
            if (batch.length > 0) {
              window.onRowsUpdated(batch);
              batch = [];
            }
          }, batchDebounce);
        }
      });
      robustObserver.observe(stableContainer, { childList: true, subtree: true, characterData: true });
      console.log(`✅ [Observer] 高效批处理观察者已启动。`);
    }, { 
        selectors: SELECTORS, 
        batchDebounce: CALLBACK_BATCH_DEBOUNCE_MS
    });

    log('✨ 高性能监听体系已建立，正在等待数据变化...');

    // --- 核心回归: 在Node.js端运行可靠的抖动器 ---
    const runRobustJiggler = async () => {
      while (isJigglerActive) {
        await new Promise(resolve => setTimeout(resolve, JIGGLE_INTERVAL_MS));
        if (!isJigglerActive) break;

        try {
          // 👈 增加你要求的日志
          log('🐭 [Jiggler] 正在从 Node.js 发起 "划入/划出" 动作...');
          await tableContainerLocator.hover({ timeout: 1000 }); // 使用 locator.hover() 更稳定
          await page.mouse.move(0, 0, { steps: 5 });        // 平滑移开
        } catch (e) {
          log(`- [Jiggler] 抖动时出错: ${e.message}`);
        }
      }
    };
    runRobustJiggler();

    const initialData = await page.evaluate(scrapeAllDataInBrowser, SELECTORS);
    log(`\n[✅ INITIAL DATA - ${new Date().toLocaleTimeString()}]`);
    handleRowsUpdate(initialData.map(item => ({ data: item, duration: 'N/A' })));
    
    log(`\n👍 脚本现在以可靠驱动模式运行 (将持续 ${SCRIPT_DURATION_SECONDS} 秒)`);
    await new Promise(resolve => setTimeout(resolve, SCRIPT_DURATION_SECONDS * 1000));

  } catch (error)
 {
    log(`❌ 脚本执行时发生严重错误: ${error.stack}`); 
  } finally {
    isJigglerActive = false;
    if (browser) {
      log('\n🏁 脚本结束，关闭浏览器.');
      await browser.close();
    }
  }
}

main();