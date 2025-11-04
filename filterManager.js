// filterManager.js
// (v18: 修正过滤器按钮选择器，解决严格模式冲突)

/**
 * 应用成交金额过滤器。
 * @param {import('playwright').Page} page - Playwright 的 Page 对象。
 * @param {number|string} minVolume - 要设置的最小成交金额。
 * @returns {Promise<void>}
 */
async function applyVolumeFilter(page, minVolume) {
  console.log(`🔍 [Filter] 准备应用成交金额过滤器，最小金额设置为: ${minVolume}`);

  try {
    // 步骤 1: 点击第7个表头的过滤按钮
    console.log('  -> [Filter] 正在点击成交金额列的过滤按钮...');

    // ==============================================================================
    // --- ✨ 修改点在这里 ---
    // 旧的选择器 page.locator('th:nth-child(7)').getByRole('button') 太模糊，会匹配到3个按钮。
    // 我们增加一个 class 选择器 .text-\[--color-PrimaryYellow\] 来精确定位那个黄色的过滤按钮。
    // 注意: CSS选择器中的特殊字符 [ 和 ] 需要用反斜杠 \ 进行转义。
    const filterButtonLocator = page.locator('th:nth-child(7)').locator('button.text-\\[--color-PrimaryYellow\\]');
    await filterButtonLocator.click();
    // ==============================================================================

    console.log('  ✅ [Filter] 过滤按钮已点击，等待弹窗出现...');

    // 步骤 2: 在弹出的窗口中找到 "最小" 输入框并填入值
    const minVolumeInput = page.getByPlaceholder('最小');
    await minVolumeInput.fill(String(minVolume));
    console.log(`  ✅ [Filter] 已在 "最小" 输入框中填入: ${minVolume}`);

    // 步骤 3: 点击 "应用" 按钮
    await page.getByRole('button', { name: '应用' }).click();
    console.log('  ✅ [Filter] 已点击 "应用" 按钮.');
    
    // 等待一小段时间，确保过滤结果已经应用到表格上
    await page.waitForTimeout(1000); 

    console.log('👍 [Filter] 成交金额过滤器已成功应用.');

  } catch (error) {
    console.error(`❌ [Filter] 应用成交金额过滤器时发生错误: ${error.message}`);
    // 如果我们希望在过滤失败时停止整个脚本，可以在这里重新抛出错误
    throw error; 
  }
}

module.exports = { applyVolumeFilter };