// hotlist.js
// (v60: 终极版 - 精确抖动器，模拟“划入/划出”强制刷新渲染队列)

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
const JIGGLE_INTERVAL_MS = 500; // 每4秒执行一次精确抖动

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
  log(`🚀 [Observer v60 - Precise Jiggler] 脚本启动...`);
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
    
    const handleRowUpdate = (updatedRow, duration) => {
      // ... (代码不变)
      if (!updatedRow || !updatedRow.symbol) return;
      log(
        `  🔄 [ROW UPDATE: ${updatedRow.symbol.padEnd(8)}] ` +
        `价格: ${(updatedRow.price || 'N/A').padEnd(10)} | ` +
        `1h成交额: ${(updatedRow.volume1h || 'N.A').padEnd(10)} | ` +
        `1h涨跌: ${(updatedRow.change1h || 'N/A').padEnd(8)} | ` +
        `(耗时: ${duration}ms)`
      );
    };
    await page.exposeFunction('onRowUpdated', handleRowUpdate);

    // ... (v58的单一健壮观察者代码完全不变) ...
    await page.evaluate((selectors) => {
      const stableContainer = document.querySelector(selectors.stableContainer);
      if (!stableContainer) { console.error(`[Observer] 致命错误: 无法找到根容器: ${selectors.stableContainer}`); return; }
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
            const duration = (performance.now() - startTime).toFixed(2);
            window.onRowUpdated(rowData, duration);
          }
        });
      });
      robustObserver.observe(stableContainer, { childList: true, subtree: true, characterData: true });
      console.log(`✅ [Observer] 单一健壮观察者已启动，正在监控: ${selectors.stableContainer}`);
    }, SELECTORS);

    log('✨ 监听体系已建立，正在等待数据变化...');

    // --- 核心升级: 精确抖动器 ---
    const runPreciseJiggler = async () => {
      while (isJigglerActive) {
        await new Promise(resolve => setTimeout(resolve, JIGGLE_INTERVAL_MS));
        if (!isJigglerActive) break;

        try {
          log('🐭 [Jiggler] 正在模拟 "划入/划出" 表格以强制刷新...');
          const tableContainer = page.locator(SELECTORS.stableContainer);
          const box = await tableContainer.boundingBox();

          if (box) {
            // 移动到表格中心，触发 mouseenter
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            // 短暂暂停，确保事件被处理
            await page.waitForTimeout(50); 
            // 移动到页面左上角，触发 mouseleave
            await page.mouse.move(0, 0);
          } else {
            log('- [Jiggler] 警告: 未找到表格容器，跳过本次抖动。');
          }
        } catch (e) {
          log(`- [Jiggler] 抖动时出错: ${e.message}`);
        }
      }
    };
    runPreciseJiggler();

    const initialData = await page.evaluate(scrapeAllDataInBrowser, SELECTORS);
    log(`\n[✅ INITIAL DATA - ${new Date().toLocaleTimeString()}]`);
    initialData.forEach(item => handleRowUpdate(item, 'N/A'));
    
    log(`\n👍 脚本现在以精确抖动模式运行 (将持续 ${SCRIPT_DURATION_SECONDS} 秒)`);
    await new Promise(resolve => setTimeout(resolve, SCRIPT_DURATION_SECONDS * 1000));

  } catch (error) {
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