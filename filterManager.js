// filterManager.js
// (v28: 引入带时间戳的日志记录)

const { log } = require('./logger.js'); // 👈 引入日志工具

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
    
    await page.waitForTimeout(1000); 

    log('👍 [Filter] 成交金额过滤器已成功应用.');

  } catch (error) {
    log(`❌ [Filter] 应用成交金额过滤器时发生错误: ${error.message}`);
    throw error; 
  }
}

module.exports = { applyVolumeFilter };