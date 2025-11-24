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

/**
 * 点击第6列（涨跌幅）的第一个按钮，以触发排序（预期结果：1H涨幅榜）
 */
export async function applyPriceChangeSort(page: Page): Promise<void> {
  log(`📉 [Sort] 准备点击第6列(涨跌幅)进行排序...`, LOG_LEVELS.INFO);

  try {
    // 定位第6列头部中的第一个按钮
    const sortButtonLocator = page.locator('th:nth-child(5) button').first();
    
    // 检查元素是否存在
    if (await sortButtonLocator.count() === 0) {
      log('  ⚠️ [Sort] 未找到第6列的排序按钮，跳过排序。', LOG_LEVELS.ERROR);
      return;
    }

    log('  -> [Sort] 正在点击排序按钮...', LOG_LEVELS.DEBUG);
    await sortButtonLocator.click();
    
    log('  -> [Sort] 按钮已点击，等待列表刷新 (2s)...', LOG_LEVELS.DEBUG);
    
    // 点击排序后，列表通常会重排，这里给予固定的缓冲时间让 React 完成渲染
    // 使用 waitForTimeout 比 networkidle 更适合这种纯前端排序或轻量请求
    await page.waitForTimeout(2000);
    
    log('✅ [Sort] 排序操作已完成，当前应为涨幅榜状态。', LOG_LEVELS.INFO);

  } catch (error: any) {
    log(`❌ [Sort] 排序操作发生错误: ${error.message}`, LOG_LEVELS.ERROR);
    // 排序失败通常不应阻断主流程，抛出错误由上层决定是否捕获，或者此处吞掉错误
    throw error; 
  }
}