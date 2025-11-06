// test-final-solution.js

// ✨ 核心变更 1: 从 undici 同时导入 request 和 ProxyAgent
const { request: fetch, ProxyAgent } = require('undici');
const fs = require('fs').promises;

const imageUrl = 'https://bin.bnbstatic.com/images/web3-data/public/token/logos/CDAA5C7642FDB9CC211B513AD991F7C8.jpg';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

async function testWithNativeProxy() {
  console.log('\n--- 正在测试【使用 undici 原生 ProxyAgent】---');
  try {
    // ✨ 核心变更 2: 使用 undici 自带的 ProxyAgent
    const proxyAgent = new ProxyAgent('socks5://127.0.0.1:1080');
    
    const response = await fetch(imageUrl, {
      dispatcher: proxyAgent, // 这个 proxyAgent 是 undici 认识的 "自己人"
      headers: { 'User-Agent': BROWSER_USER_AGENT },
    });
    
    if (response.statusCode !== 200) {
        throw new Error(`服务器返回了错误的状态码: ${response.statusCode}`);
    }

    const imageBuffer = Buffer.from(await response.body.arrayBuffer());
    await fs.writeFile('test-final-image.jpg', imageBuffer);
    console.log('✅ 成功下载！图片已保存为 test-final-image.jpg');
  } catch (error) {
    console.error(`❌ 失败: ${error.message}`);
  }
}

async function main() {
  await testWithNativeProxy();
  console.log('\n--- 测试完成 ---');
}

main();