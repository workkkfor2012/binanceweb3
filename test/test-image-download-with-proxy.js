// test-image-download-with-proxy.js

const { request: fetch } = require('undici');
const fs = require('fs').promises;
const { SocksProxyAgent } = require('socks-proxy-agent');

const imageUrl = 'https://bin.bnbstatic.com/images/web3-data/public/token/logos/CDAA5C7642FDB9CC211B513AD991F7C8.jpg';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// --- 测试 1: 不带 User-Agent (预期失败) ---
async function testWithoutUserAgent() {
  console.log('\n--- 1. 测试【无代理，无 User-Agent】---');
  try {
    const response = await fetch(imageUrl);
    if (response.statusCode !== 200) throw new Error(`状态码: ${response.statusCode}`);
    await fs.writeFile('test-image-1.jpg', Buffer.from(await response.body.arrayBuffer()));
    console.log('✅ 成功');
  } catch (error) {
    console.error(`❌ 失败: ${error.message}`);
  }
}

// --- 测试 2: 带有 User-Agent (预期失败) ---
async function testWithUserAgent() {
  console.log('\n--- 2. 测试【无代理，有 User-Agent】---');
  try {
    const response = await fetch(imageUrl, { headers: { 'User-Agent': BROWSER_USER_AGENT } });
    if (response.statusCode !== 200) throw new Error(`状态码: ${response.statusCode}`);
    await fs.writeFile('test-image-2.jpg', Buffer.from(await response.body.arrayBuffer()));
    console.log('✅ 成功');
  } catch (error) {
    console.error(`❌ 失败: ${error.message}`);
  }
}

// --- 测试 3: 带有代理 (预期成功) ---
async function testWithProxy() {
  console.log('\n--- 3. 测试【有代理，有 User-Agent】---');
  try {
    const proxyAgent = new SocksProxyAgent('socks5://127.0.0.1:1080');
    const response = await fetch(imageUrl, {
      dispatcher: proxyAgent, // 使用代理
      headers: { 'User-Agent': BROWSER_USER_AGENT },
    });
    if (response.statusCode !== 200) throw new Error(`状态码: ${response.statusCode}`);
    const imageBuffer = Buffer.from(await response.body.arrayBuffer());
    await fs.writeFile('test-image-proxy.jpg', imageBuffer);
    console.log('✅ 成功下载！图片已保存为 test-image-proxy.jpg');
  } catch (error) {
    console.error(`❌ 失败: ${error.message}`);
  }
}

// --- 运行测试 ---
async function main() {
  await testWithoutUserAgent();
  await testWithUserAgent();
  await testWithProxy();
  console.log('\n--- 测试完成 ---');
}

main();