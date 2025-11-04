// hotlist_v45_scan_to_tr.js
// 目的：在 v44 的基础上，将深度遍历的目标精准地限制在 <tr> 级别。
// 这将以最简洁的方式告诉我们，数据行是否存在。

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { handleGuidePopup, checkAndClickCookieBanner } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js'); // 必须是 v29 版本
const { log } = require('./logger.js');

chromium.use(stealth);

// ==============================================================================
// --- ⚙️ 配置区 ---
// ==============================================================================
const SCRIPT_DURATION_SECONDS = 30; 
const POLLING_INTERVAL_MS = 5000; 
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 20000;

const SELECTORS = {
  tableContainer: 'div.markets-table', 
  tableBody:      'div.markets-table > table > tbody',
};
// ==============================================================================

// ... scrapeDataInBrowser 函数保持不变，用于触发检查 ...
function scrapeDataInBrowser(selectors) {
  const tableBody = document.querySelector(selectors.tableBody);
  if (!tableBody) return [];
  // ... 逻辑不变 ...
  return [];
}

/**
 * 深度遍历并生成 DOM 结构树的函数 (遍历到 <tr> 停止)
 */
function generateDomTree(selector) {
    const startNode = document.querySelector(selector);
    if (!startNode) {
        return `[ERROR] 无法找到起始节点 "${selector}"`;
    }

    function traverse(node, prefix = '', isLast = true) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return '';

        const connector = isLast ? '└── ' : '├── ';
        let details = `${node.tagName.toLowerCase()}`;
        if (node.id) details += `#${node.id}`;
        if (node.className && typeof node.className === 'string') {
            details += `.${node.className.replace(/\s+/g, '.')}`;
        }

        let output = `${prefix}${connector}${details}\n`;

        // --- 核心修改 ---
        // 如果当前节点是 TR，则不再继续深入
        if (node.tagName.toLowerCase() === 'tr') {
            return output;
        }

        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        const children = Array.from(node.children);
        children.forEach((child, index) => {
            output += traverse(child, newPrefix, index === children.length - 1);
        });
        return output;
    }
    return `[ ${selector} ] 的DOM结构树 (到TR为止):\n${traverse(startNode)}`;
}


async function main() {
  let browser;
  let keepPolling = true;
  log('🚀 [Scan-to-TR Polling v45] 脚本启动...');
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
    await applyVolumeFilter(page, MIN_VOLUME_FILTER);

    const pollData = async () => {
      if (!keepPolling) return;

      log(`- [Polling Heartbeat] 正在尝试抓取数据 (使用选择器: ${SELECTORS.tableBody})...`);
      try {
        const currentData = await page.evaluate((s) => document.querySelectorAll(s.tableBody + ' tr').length, SELECTORS);
        log(`- [Polling Heartbeat] 抓取完成. 快速检查找到 ${currentData} 行数据.`);

        if (currentData === 0) {
            log(`\n🕵️  [DEEP SCAN] 数据为0行，立即对容器 "${SELECTORS.tableContainer}" 进行深度结构扫描 (到TR为止)...`);
            const domTree = await page.evaluate(generateDomTree, SELECTORS.tableContainer);
            
            console.log('--------------------------------------------------');
            console.log(domTree);
            console.log('--------------------------------------------------');

            if (domTree.includes('tbody') && domTree.includes('tr')) {
                 log('  - [DEEP SCAN] 结论: 结构完整，但快速检查的逻辑有误。');
            } else if (domTree.includes('table') && !domTree.includes('tbody')) {
                 log('  - [DEEP SCAN] 结论: **找到了！** 容器内有 table，但没有 tbody！这就是我们找不到数据的原因！');
                 keepPolling = false; 
            } else if (domTree.includes('tbody') && !domTree.includes('tr')) {
                 log('  - [DEEP SCAN] 结论: **找到了！** 容器内有 tbody，但 tbody 内部是空的，没有任何 tr (数据行)！');
                 keepPolling = false; 
            } else {
                 log('  - [DEEP SCAN] 结论: 请分析上面的DOM树结构。');
            }
        }
      } catch (e) {
        log(`- [Polling FATAL ERROR] 抓取时发生致命错误: ${e.message}`);
      } finally {
        if (keepPolling) {
          setTimeout(pollData, POLLING_INTERVAL_MS);
        }
      }
    };

    log(`\n✨ 启动诊断轮询器...`);
    pollData(); 

    await new Promise(resolve => setTimeout(resolve, SCRIPT_DURATION_SECONDS * 1000));

  } catch (error) {
    log(`❌ 脚本执行时发生错误: ${error.stack}`); 
  } finally {
    keepPolling = false;
    if (browser) {
      log('\n🏁 脚本结束，关闭浏览器.');
      await browser.close();
    }
  }
}

main();