// hotlist.js
// (v21: 采用“智能处理”模型，主流程清晰健壮)

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { initializePage } = require('./pageInitializer.js'); // 👈 引用新的 initializePage
const { applyVolumeFilter } = require('./filterManager.js');

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 (移除了 PATROL_DURATION_SECONDS) ---
// ==============================================================================
const SCRIPT_DURATION_SECONDS = 180;
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 1000;

const SELECTORS = {
  tableBody: 'div.bn-web-table-body tbody',
  symbol:         'td:nth-child(1) .shrink-0.t-subtitle1',
  liquidity:      'td:nth-child(2) .flex.items-center.gap-0\\.5 > span',
  marketCap:      'td:nth-child(4) span.flex.items-center.text-\\[--color-PrimaryYellow\\] > span',
  price:          'td:nth-child(4) .t-caption1.text-\\[--color-PrimaryText\\]',
  change1h:       'td:nth-child(5) > span',
  transactions1h: 'td:nth-child(6) .bn-tooltips-ele > span',
  volume1h:       'td:nth-child(7) .text-\\[--color-PrimaryYellow\\]',
};
// ==============================================================================

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ 
      executablePath: MY_CHROME_PATH, 
      headless: false, 
      proxy: { server: 'socks5://127.0.0.1:1080' },
      args: ['--start-maximized']
    });
    
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    await page.exposeFunction('onRowDataChanged', (data) => {
      console.log(
        `[⚡️ DOM NOTIFY] ` +
        `[${(data.symbol || 'N/A').padEnd(8)}] ` +
        `价格: ${(data.price || 'N/A').padEnd(10)} | ` +
        `市值: ${(data.marketCap || 'N/A').padEnd(12)} | ` +
        `流动性: ${(data.liquidity || 'N/A').padEnd(10)} | ` +
        `1h成交额: ${(data.volume1h || 'N/A').padEnd(10)} | ` +
        `1h笔数: ${(data.transactions1h || 'N/A').padEnd(8)} | `+
        `1h涨跌: ${data.change1h || 'N/A'}`
      );
    });

    const targetUrl = 'https://web3.binance.com/zh-CN/markets/trending?chain=bsc';
    console.log(`🧭 正在导航到: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 90000 });

    // ==============================================================================
    // --- ✨ 智能并行初始化策略 ---
    // ==============================================================================
    // 步骤 1: 立即派遣“智能处理程序”到后台执行，但不等待它完成。
    // 这将返回一个 Promise，我们将其存起来。
    console.log('🚀 [Init] 已派遣智能处理程序在后台开始工作...');
    const initializationPromise = initializePage(page);

    // 步骤 2: “主部队”继续前进，等待自己的核心目标——数据表格。
    console.log(`⏳ [Main] 主流程开始等待核心数据表格 (${SELECTORS.tableBody}) 出现...`);
    await page.waitForSelector(SELECTORS.tableBody);
    console.log('✅ [Main] 核心数据表格已出现.');

    // 步骤 3: 在进行下一步交互（过滤）之前，我们必须确保“智能处理程序”已完成清场。
    // 在这里等待之前保存的 Promise。
    console.log('🤝 [Sync] 等待后台的弹窗处理程序完成任务...');
    await initializationPromise;
    console.log('👍 [Sync] 所有弹窗已处理完毕，环境安全。');

    // 步骤 4: 现在环境干净了，安全地应用过滤器。
    await applyVolumeFilter(page, MIN_VOLUME_FILTER);
    // ==============================================================================
    
    // ... 后续的 page.evaluate 和 MutationObserver 逻辑保持不变 ...
    await page.evaluate((selectors) => {
      const targetNode = document.querySelector(selectors.tableBody);
      if (!targetNode) return;
      const observer = new MutationObserver((mutationsList) => {
        const updatedRows = new Set();
        for (const mutation of mutationsList) {
            const rowElement = mutation.target.closest('tr');
            if (rowElement && rowElement.hasAttribute('data-row-key') && !updatedRows.has(rowElement)) {
                updatedRows.add(rowElement);
            }
        }
        updatedRows.forEach(rowElement => {
            try {
                const data = {};
                for (const key in selectors) {
                    if (key !== 'tableBody') {
                        data[key] = rowElement.querySelector(selectors[key])?.textContent.trim();
                    }
                }
                window.onRowDataChanged(data);
            } catch (e) {}
        });
      });
      const config = { characterData: true, subtree: true, childList: true };
      observer.observe(targetNode, config);
      console.log('✅ MutationObserver 已在浏览器中启动...');
    }, SELECTORS);

    console.log(`\n✨ 已启动 MutationObserver. 现在开始实时监听DOM变化... (将运行 ${SCRIPT_DURATION_SECONDS} 秒)`);
    await new Promise(resolve => setTimeout(resolve, SCRIPT_DURATION_SECONDS * 1000));

  } catch (error) {
    console.error(`❌ 脚本执行时发生错误: ${error.message}`);
  } finally {
    if (browser) {
      console.log('\n🏁 脚本结束，关闭浏览器.');
      await browser.close();
    }
  }
}

main();