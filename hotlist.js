// hotlist.js
// hotlist.js
// (v30: 增强 MutationObserver 的错误日志)

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { handleGuidePopup, checkAndClickCookieBanner } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js');
const { log } = require('./logger.js'); // 重新引入日志工具

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 (无变化) ---
// ==============================================================================
const SCRIPT_DURATION_SECONDS = 180;
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 20000;
const TABLE_WAIT_TIMEOUT = 10000;

const SELECTORS = {
  tableBody: 'div.bn-web-table-body tbody',
  symbol:         'td:nth-child(1) .shrink-0.t-subtitle1',
  liquidity:      'td:nth-child(2) .flex.items-center.gap-0\\.5 > span',
  marketCap:      'td:nth-child(4) span.flex.items-center.text-\\[--color-PrimaryYellow\\] > span',
  price:          'td:nth-child(4) .t-caption1.text-\\[--color-PrimaryText\\]',
  change1h:       'td:nth-child(5) a span', // 👈 **这里是修改后的选择器**
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
      // 在 Node.js 环境使用我们自己的 log 函数
      log(
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
    log(`🧭 正在导航到: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 90000 });

    // ==============================================================================
    // --- ✨ 事件驱动的串行流程 (无变化) ---
    // ==============================================================================
    await handleGuidePopup(page);
    await checkAndClickCookieBanner(page);
    log('✅ 所有弹窗已清理完毕，页面就绪。');

    log(`  -> [Final-Check] 正在确认核心数据表格...`);
    await page.waitForSelector(SELECTORS.tableBody, { timeout: TABLE_WAIT_TIMEOUT });
    log('     ✅ 核心数据表格已确认存在。');

    await applyVolumeFilter(page, MIN_VOLUME_FILTER);
    // ==============================================================================
    
    // 注入并启动 MutationObserver
    await page.evaluate((selectors) => {
      const targetNode = document.querySelector(selectors.tableBody);
      if (!targetNode) {
        console.error("无法找到要监视的表格主体 (tbody)");
        return;
      }

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
            } catch (e) {
                // 【关键改进】不再吞掉错误，而是在浏览器控制台打印出来，方便调试
                console.error('❌ 在从DOM行提取数据时出错:', {
                    error: e.message,
                    rowHTML: rowElement.innerHTML, // 附上出错行的HTML，便于分析
                });
            }
        });
      });

      const config = { characterData: true, subtree: true, childList: true };
      observer.observe(targetNode, config);
      // 这个 console.log 会显示在浏览器的控制台
      console.log('✅ MutationObserver 已在浏览器中启动...'); 
    }, SELECTORS);

    log(`\n✨ 已启动 MutationObserver. 现在开始实时监听DOM变化... (将运行 ${SCRIPT_DURATION_SECONDS} 秒)`);
    await new Promise(resolve => setTimeout(resolve, SCRIPT_DURATION_SECONDS * 1000));

  } catch (error) {
    log(`❌ 脚本执行时发生错误: ${error.stack}`); // 使用 error.stack 获取更详细的错误信息
  } finally {
    if (browser) {
      log('\n🏁 脚本结束，关闭浏览器.');
      await browser.close();
    }
  }
}

main();