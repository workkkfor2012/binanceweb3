// hotlist.js (v12: 复合选择器终极版)

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区: 基于您的精确复合选择器分析 ---
// ==============================================================================
const SELECTORS = {
  // 1. 数据表格的<tbody>
  tableBody: 'div.bn-web-table-body tbody',

  // 2. 在单个“行”内部，各个数据列的复合选择器
  //    格式: 'td:nth-child(列号) class选择器'
  symbol:         'td:nth-child(1) .shrink-0.t-subtitle1',
  liquidity:      'td:nth-child(2) .flex.items-center.gap-0\\.5 > span', // 注意 .5 需要转义
  marketCap:      'td:nth-child(4) span.flex.items-center.text-\\[--color-PrimaryYellow\\] > span', // 注意 [] 需要转义
  price:          'td:nth-child(4) .t-caption1.text-\\[--color-PrimaryText\\]', // 注意 [] 需要转义
  change1h:       'td:nth-child(5) > span', // 第5个td下的span
  transactions1h: 'td:nth-child(6) .bn-tooltips-ele > span',
  volume1h:       'td:nth-child(7) .text-\\[--color-PrimaryYellow\\]', // 注意 [] 需要转义
};
// ==============================================================================

const SCRIPT_DURATION_SECONDS = 180;
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: MY_CHROME_PATH, headless: true, proxy: { server: 'socks5://127.0.0.1:1080' } });
    const context = await browser.newContext();
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
    
    console.log(`⏳ 正在等待数据表格 (${SELECTORS.tableBody}) 出现...`);
    await page.waitForSelector(SELECTORS.tableBody);
    console.log('✅ 数据表格已出现.');

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
                // 使用 for...in 循环遍历配置的选择器，动态提取数据
                for (const key in selectors) {
                    if (key !== 'tableBody') { // 排除 tableBody
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