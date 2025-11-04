// hotlist.js
// hotlist.js (V19: 采用“大等待”+“大扫除”策略，确保时序正确)

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { initializePage } = require('./pageInitializer.js');
const { applyVolumeFilter } = require('./filterManager.js');

chromium.use(stealth);

// --- ⚙️ 配置区 (无变化) ---
const SCRIPT_DURATION_SECONDS = 180;
const MY_CHROME_PATH = 'F:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIN_VOLUME_FILTER = 1000;
const SELECTORS = { /* ... */ };

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

    // ... exposeFunction (无变化) ...
    await page.exposeFunction('onRowDataChanged', (data) => { /* ... */ });

    const targetUrl = 'https://web3.binance.com/zh-CN/markets/trending?chain=bsc';
    console.log(`🧭 正在导航到: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 90000 });

    // ==============================================================================
    // --- ✨ “大等待” + “大扫除” 策略 ---
    // ==============================================================================
    
    // 步骤 1: “大等待” - 等待第一个可交互迹象出现
    console.log('⏳ [Grand Wait] 正在等待页面的第一个交互迹象 (引导窗 或 核心表格)...');
    try {
      await Promise.race([
        // 等待“下一步”按钮
        page.waitForSelector('text="下一步"', { timeout: 30000 }),
        // 等待“Cookie”按钮
        page.waitForSelector('text="接受所有 Cookie"', { timeout: 30000 }),
        // 等待核心表格
        page.waitForSelector(SELECTORS.tableBody, { timeout: 30000 })
      ]);
      console.log('✅ [Grand Wait] 页面已“苏醒”，至少一个关键元素已出现。');
    } catch (e) {
      console.error('❌ [Grand Wait] 页面在30秒内未加载任何关键内容，脚本终止。');
      throw e; // 抛出错误，终止后续执行
    }

    // 步骤 2: “大扫除” - 现在页面已激活，执行完整的、并行的清理程序
    // 我们在这里完整地 await 它，给它足够的时间来处理所有可能陆续出现的弹窗。
    console.log('🧹 [Cleanup] 开始对页面进行全面清理...');
    await initializePage(page);
    console.log('👍 [Cleanup] 页面清理完毕。');

    // 步骤 3: 现在环境绝对干净了，安全地应用过滤器。
    await applyVolumeFilter(page, MIN_VOLUME_FILTER);
    
    // ==============================================================================
    
    // ... 后续的 page.evaluate 和 MutationObserver 逻辑保持不变 ...
    // 注意：我们不再需要在这里单独等待 tableBody，因为“大等待”和后续流程已确保其存在。
    console.log('✅ 核心逻辑开始执行，数据表格已就绪。');

    await page.evaluate((selectors) => { /* ... */ });

    console.log(`\n✨ 已启动 MutationObserver... (将运行 ${SCRIPT_DURATION_SECONDS} 秒)`);
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