// logger.js

/**
 * 获取当前时间的 [分:秒] 格式字符串
 * @returns {string} e.g., "[08:21]"
 */
function getTimestamp() {
  const now = new Date();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `[${minutes}:${seconds}]`;
}

/**
 * 带有时间戳的日志打印函数
 * @param {string} message - 要打印的信息
 */
function log(message) {
  console.log(`${getTimestamp()} ${message}`);
}

module.exports = { log };