// packages/extractor/src/filterManager.ts
import { Page } from 'playwright';
import { log, LOG_LEVELS } from './logger';

export async function applyVolumeFilter(page: Page, minVolume: number | string): Promise<void> {
  log(`🔍 [Filter] 准备应用成交金额过滤器，最小金额设置为: ${minVolume}`, LOG_LEVELS.INFO);

  try {
    const filterButtonLocator = page.locator('th:nth-child(7)').locator('button.text-\\[--color-PrimaryYellow\\]');
    
    log('  -> [Filter] 正在点击成交金额列的过滤按钮...', LOG_LEVELS.DEBUG);
    await filterButtonLocator.click();
    log('  ✅ [Filter] 过滤按钮已点击，等待弹窗出现...', LOG_LEVELS.DEBUG);

    const minVolumeInput = page.getByPlaceholder('最小');
    await minVolumeInput.fill(String(minVolume));
    log(`  ✅ [Filter] 已在 "最小" 输入框中填入: ${minVolume}`, LOG_LEVELS.DEBUG);

    await page.getByRole('button', { name: '应用' }).click();
    log('  ✅ [Filter] 已点击 "应用" 按钮.', LOG_LEVELS.DEBUG);
    
    log('  -> [Filter] 等待导航和网络请求稳定...', LOG_LEVELS.INFO);
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    
    log('👍 [Filter] 过滤器已成功应用，页面已完全稳定.', LOG_LEVELS.INFO);

  } catch (error: any) {
    log(`❌ [Filter] 应用成交金额过滤器时发生错误: ${error.message}`, LOG_LEVELS.ERROR);
    throw error; 
  }
}