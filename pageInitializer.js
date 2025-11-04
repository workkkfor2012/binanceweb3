// pageInitializer.js
// (v19: 采用 Promise.all 实现真正的并行、顺序无关的弹窗处理)

/**
 * 辅助函数：单个“巡逻兵”的行为逻辑。
 * 通过轮询方式，点击所有包含指定文本的按钮，直到页面上再也找不到为止。
 * @param {import('playwright').Page} page Playwright Page 对象
 * @param {string} textToClick 要点击的按钮的精确文本
 * @returns {Promise<void>}
 */
async function clickAllByText(page, textToClick) {
  const CLICK_TIMEOUT = 2000; 
  let clickCount = 0;

  console.log(`  -> [Patrol Squad for "${textToClick}"] 已出发，开始巡逻...`);
  
  while (true) {
    try {
      await page.getByText(textToClick, { exact: true }).click({ timeout: CLICK_TIMEOUT });
      clickCount++;
      console.log(`     ✅ [Patrol Squad for "${textToClick}"] 发现并处理了第 ${clickCount} 个目标.`);
      await page.waitForTimeout(500); 
    } catch (error) {
      if (clickCount > 0) {
        console.log(`  👍 [Patrol Squad for "${textToClick}"] 报告：区域内目标已全部清除 (共 ${clickCount} 个).`);
      } else {
        // 这一条可以不打印，避免日志过于杂乱
        // console.log(`  ℹ️ [Patrol Squad for "${textToClick}"] 报告：巡逻完毕，未发现目标.`);
      }
      break; 
    }
  }
}

/**
 * 初始化页面总指挥：同时派遣多个“巡逻兵”，并等待他们全部完成任务。
 * @param {import('playwright').Page} page - Playwright 的 Page 对象。
 * @returns {Promise<void>}
 */
async function initializePage(page) {
  console.log('🔍 [Commander] 正在派遣三支巡逻队，进行并行清理...');
  
  // Promise.all 接收一个 Promise 数组。
  // clickAllByText 本身就是一个返回 Promise 的 async 函数。
  // 我们同时启动这三个任务，Promise.all 会等待它们全部执行完毕。
  await Promise.all([
    clickAllByText(page, '下一步'),
    clickAllByText(page, '我已知晓'),
    clickAllByText(page, '接受所有 Cookie')
  ]);
  
  console.log('👍 [Commander] 所有巡逻队均已报告任务完成！');
}

module.exports = { initializePage };