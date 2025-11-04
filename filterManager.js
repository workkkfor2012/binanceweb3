// filterManager.js
// (v29: 增加等待网络空闲的逻辑，以应对导航式刷新)

const { log } = require('./logger.js');

/**
 * 应用成交金额过滤器。
 * @param {import('playwright').Page} page - Playwright 的 Page 对象。
 * @param {number|string} minVolume - 要设置的最小成交金额。
 * @returns {Promise<void>}
 */
async function applyVolumeFilter(page, minVolume) {
  log(`🔍 [Filter] 准备应用成交金额过滤器，最小金额设置为: ${minVolume}`);

  try {
    const filterButtonLocator = page.locator('th:nth-child(7)').locator('button.text-\\[--color-PrimaryYellow\\]');
    
    log('  -> [Filter] 正在点击成交金额列的过滤按钮...');
    await filterButtonLocator.click();
    log('  ✅ [Filter] 过滤按钮已点击，等待弹窗出现...');

    const minVolumeInput = page.getByPlaceholder('最小');
    await minVolumeInput.fill(String(minVolume));
    log(`  ✅ [Filter] 已在 "最小" 输入框中填入: ${minVolume}`);

    await page.getByRole('button', { name: '应用' }).click();
    log('  ✅ [Filter] 已点击 "应用" 按钮.');
    
    // --- 🚀 【最终驱魔代码】 ---
    // 等待导航触发的网络请求全部完成并进入空闲状态
    log('  -> [Filter] 等待导航和网络请求稳定...');
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    
    log('👍 [Filter] 过滤器已成功应用，页面已完全稳定.');

  } catch (error) {
    log(`❌ [Filter] 应用成交金额过滤器时发生错误: ${error.message}`);
    throw error; 
  }
}

module.exports = { applyVolumeFilter };