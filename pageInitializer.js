// pageInitializer.js

const { log, LOG_LEVELS } = require('./logger.js'); // 引入 log 和 LOG_LEVELS

const GUIDE_POPUP_SELECTOR = '#__APP > div.bn-trans.data-show.bn-mask.bn-modal > div';
const COOKIE_BANNER_SELECTOR = '#onetrust-banner-sdk';
const GUIDE_POPUP_WAIT_TIMEOUT = 45000;

async function handleGuidePopup(page) {
  try {
    log(`⏳ [Main-Wait] 正在等待核心事件：引导弹窗出现...`, LOG_LEVELS.INFO);
    const container = page.locator(GUIDE_POPUP_SELECTOR);
    
    const nextButton = container.getByText('下一步', { exact: true });
    await nextButton.first().waitFor({ state: 'visible', timeout: GUIDE_POPUP_WAIT_TIMEOUT });

    log('     ✅ 引导弹窗已完全就绪，开始处理...', LOG_LEVELS.DEBUG);

    while (await nextButton.count() > 0) {
      await nextButton.first().click({ timeout: 2000 });
      log('        -> 点击了 "下一步".', LOG_LEVELS.DEBUG);
      await page.waitForTimeout(500);
    }

    const knownButton = container.getByText('我已知晓', { exact: true });
    if (await knownButton.count() > 0) {
      await knownButton.click({ timeout: 2000 });
      log('        -> 点击了 "我已知晓".', LOG_LEVELS.DEBUG);
    }
    log('  👍 引导弹窗处理完毕.', LOG_LEVELS.INFO);
  } catch (error) {
    log(`  ℹ️ 未检测到引导弹窗 (超时)，流程继续.`, LOG_LEVELS.INFO);
  }
}

async function checkAndClickCookieBanner(page) {
  log(`  -> [Quick-Check] 正在快速检查Cookie横幅...`, LOG_LEVELS.INFO);
  const banner = page.locator(COOKIE_BANNER_SELECTOR);
  
  if (await banner.isVisible({ timeout: 1000 })) {
    log('     ✅ Cookie横幅存在，正在点击...', LOG_LEVELS.DEBUG);
    try {
      await banner.getByText('接受所有 Cookie', { exact: true }).click({ timeout: 2000 });
      log('        -> 点击了 "接受所有 Cookie".', LOG_LEVELS.DEBUG);
      log('  👍 Cookie横幅处理完毕.', LOG_LEVELS.INFO);
    } catch(e) {
      log('     ❌ 点击Cookie按钮失败，但流程继续。', LOG_LEVELS.ERROR);
    }
  } else {
    log('     ℹ️ 未发现Cookie横幅，跳过.', LOG_LEVELS.INFO);
  }
}

module.exports = { 
  handleGuidePopup,
  checkAndClickCookieBanner
};