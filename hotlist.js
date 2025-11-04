// hotlist.js
// hotlist.js (v16: 优化加载时机，先等核心内容再处理弹窗)

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { initializePage } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js');

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const SCRIPT_DURATION_SECONDS = 180;
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 10000;

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
    // --- ✨ 新的、更可靠的执行顺序 ---
    // ==============================================================================
    // 步骤 1: 首先等待页面的核心元素（数据表格）出现。
    // 这标志着主应用已经加载完成。
    console.log(`⏳ 正在等待核心数据表格 (${SELECTORS.tableBody}) 出现...`);
    await page.waitForSelector(SELECTORS.tableBody);
    console.log('✅ 核心数据表格已出现.');

    // 步骤 2: 此时再进行页面初始化，处理可能出现的弹窗。
    // 因为主应用已加载，弹窗有很大概率已经或即将出现。
    await initializePage(page);

    // 步骤 3: 应用过滤器
    await applyVolumeFilter(page, MIN_VOLUME_FILTER);
    // ==============================================================================
    
    // 因为我们前面已经等待过表格了，所以这里的 waitForSelector 其实是多余的，
    // 但保留也无妨，它会立刻通过。为了代码整洁，我们也可以直接开始 evaluate。
    // console.log(`⏳ 正在等待数据表格 (${SELECTORS.tableBody}) 出现...`);
    // await page.waitForSelector(SELECTORS.tableBody);
    // console.log('✅ 数据表格已出现.');

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