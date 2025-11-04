// pageInitializer.js
// (v21: 升级为“智能处理”模型，先定位容器再操作)

const GUIDE_POPUP_SELECTOR = '#__APP > div.bn-trans.data-show.bn-mask.bn-modal > div';
const COOKIE_BANNER_SELECTOR = '#onetrust-banner-sdk';
const POPUP_WAIT_TIMEOUT = 30000; // 等待弹窗出现的最长时间（30秒）

/**
 * 智能处理程序 1: 处理新手引导弹窗
 * 它会先等待引导弹窗的容器出现，然后循环点击内部的“下一步”和“我已知晓”按钮。
 * @param {import('playwright').Page} page Playwright Page 对象
 */
async function handleGuidePopup(page) {
  try {
    console.log(`  -> [Handler-Guide] 正在监视引导弹窗 (${GUIDE_POPUP_SELECTOR})...`);
    // 步骤1: 等待引导弹窗的容器变得可见
    const container = page.locator(GUIDE_POPUP_SELECTOR);
    await container.waitFor({ state: 'visible', timeout: POPUP_WAIT_TIMEOUT });
    console.log('     ✅ [Handler-Guide] 引导弹窗已出现，开始处理...');

    // 步骤2: 循环处理“下一步”按钮
    while (await container.getByText('下一步', { exact: true }).count() > 0) {
      await container.getByText('下一步', { exact: true }).click({ timeout: 2000 });
      console.log('        -> [Handler-Guide] 点击了 "下一步".');
      await page.waitForTimeout(500); // 等待UI响应
    }

    // 步骤3: 处理“我已知晓”按钮
    if (await container.getByText('我已知晓', { exact: true }).count() > 0) {
      await container.getByText('我已知晓', { exact: true }).click({ timeout: 2000 });
      console.log('        -> [Handler-Guide] 点击了 "我已知晓".');
    }

    console.log('  👍 [Handler-Guide] 引导弹窗处理完毕.');

  } catch (error) {
    // 如果在超时时间内没有等到弹窗，这不是一个致命错误，只是说明这次它没出现
    console.log(`  ℹ️ [Handler-Guide] 在 ${POPUP_WAIT_TIMEOUT / 1000} 秒内未检测到引导弹窗，跳过处理.`);
  }
}

/**
 * 智能处理程序 2: 处理 Cookie 横幅
 * @param {import('playwright').Page} page Playwright Page 对象
 */
async function handleCookieBanner(page) {
  try {
    console.log(`  -> [Handler-Cookie] 正在监视Cookie横幅 (${COOKIE_BANNER_SELECTOR})...`);
    // 步骤1: 等待Cookie横幅的容器变得可见
    const container = page.locator(COOKIE_BANNER_SELECTOR);
    await container.waitFor({ state: 'visible', timeout: POPUP_WAIT_TIMEOUT });
    console.log('     ✅ [Handler-Cookie] Cookie横幅已出现，开始处理...');
    
    // 步骤2: 点击“接受所有 Cookie”按钮
    await container.getByText('接受所有 Cookie', { exact: true }).click({ timeout: 2000 });
    console.log('        -> [Handler-Cookie] 点击了 "接受所有 Cookie".');
    
    console.log('  👍 [Handler-Cookie] Cookie横幅处理完毕.');

  } catch (error) {
    console.log(`  ℹ️ [Handler-Cookie] 在 ${POPUP_WAIT_TIMEOUT / 1000} 秒内未检测到Cookie横幅，跳过处理.`);
  }
}


/**
 * 初始化页面总指挥：并行部署并等待所有智能处理程序完成任务。
 * @param {import('playwright').Page} page - Playwright 的 Page 对象。
 * @returns {Promise<void>}
 */
async function initializePage(page) {
  console.log('🔍 [Commander] 正在并行部署所有弹窗智能处理程序...');
  
  // 使用 Promise.all 并行运行所有独立的处理器，并等待它们全部完成
  await Promise.all([
    handleGuidePopup(page),
    handleCookieBanner(page)
  ]);
  
  console.log('👍 [Commander] 所有弹窗处理程序均已执行完毕！');
}

module.exports = { initializePage };