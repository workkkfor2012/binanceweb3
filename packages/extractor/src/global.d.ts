// packages/extractor/src/global.d.ts
import type { ExtractedDataPayload } from 'shared-types';

declare global {
  interface Window {
    // 声明从 Playwright 暴露的函数
    onDataExtracted: (payload: ExtractedDataPayload) => void;
    // 声明我们为了安全日志而备份的原始 console.log
    originalConsoleLog: (...args: any[]) => void;
  }
}

// 导出空对象以确保这是一个模块文件
export {};