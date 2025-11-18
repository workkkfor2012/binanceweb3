// packages/extractor/src/kline-investigator.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

//const TARGET_URL = 'https://web3.binance.com/zh-CN/token/bsc/0xea37a8de1de2d9d10772eeb569e28bfa5cb17707';
//const TARGET_URL = 'https://web3.binance.com/zh-CN/token/sol/6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN';
const TARGET_URL = 'https://web3.binance.com/zh-CN/token/base/0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';

async function investigate() {
    console.log('🚀 [Investigator v3.1 - Fused] 启动侦察模式...');
    
    const interceptorScriptPath = path.join(__dirname, '..', 'src', 'kline-interceptor.js');
    const interceptorScript = await fs.readFile(interceptorScriptPath, 'utf-8');
    
    const browser = await chromium.launch({
        headless: false,
        devtools: true,
        proxy: { server: 'socks5://127.0.0.1:1080' },
        args: ['--start-maximized'],
    });

    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();

    // ✨ --- 关键：采用你已有的成熟方案 --- ✨
    // 在注入我们的主拦截脚本之前，先运行这个备份脚本。
    await page.addInitScript({ content: 'window.originalConsoleLog = console.log;' });
    
    // 然后注入我们的拦截脚本
    await page.addInitScript({ content: interceptorScript });

    console.log(`[Navi] 导航至目标页面: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 90000 });

    console.log('\n=============================================================');
    console.log('✅ 浏览器已启动，拦截器和 console 保护已注入。');
    console.log('👀 请切换到浏览器窗口，在开发者工具的 "Console" 中查看日志。');
    console.log('=============================================================');
    
    await new Promise(() => {});
}

investigate().catch(err => console.error('❌ 调查脚本发生严重错误:', err));