// logger.js

const fs = require('fs');
const path = require('path');

// --- 配置 ---
const LOG_LEVELS = {
  DEBUG: 1, // 用于详细的调试信息
  INFO: 2,  // 用于常规流程信息
  DISCOVERY: 3, // 用于发现重要数据
  ERROR: 4, // 用于错误信息
};

// 设置当前脚本的日志级别，只有大于等于此级别的日志才会被记录
const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO; 
const LOG_DIRECTORY = path.join(__dirname, 'logs'); // 日志文件将存放在项目根目录的 'logs' 文件夹下
// ---

let logStream = null;

/**
 * 初始化日志记录器。创建一个带时间戳的日志文件。
 * 必须在脚本开始时调用。
 */
function init() {
  if (!fs.existsSync(LOG_DIRECTORY)){
    fs.mkdirSync(LOG_DIRECTORY);
  }
  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-').slice(0, -5); // e.g., 2023-10-27T08-30-00
  const logFileName = `run_${timestamp}.log`;
  const logFilePath = path.join(LOG_DIRECTORY, logFileName);
  
  logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  console.log(`[Logger] 日志文件已创建: ${logFilePath}`);
}

/**
 * 获取当前时间的 [分:秒.毫秒] 格式字符串
 * @returns {string} e.g., "[08:21:55.123]"
 */
function getTimestamp() {
  const now = new Date();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  return `[${minutes}:${seconds}.${milliseconds}]`;
}

/**
 * 带有时间戳和级别的日志打印函数
 * @param {string} message - 要打印的信息
 * @param {number} [level=LOG_LEVELS.INFO] - 日志级别
 */
function log(message, level = LOG_LEVELS.INFO) {
  if (level < CURRENT_LOG_LEVEL) {
    return; // 低于设定级别的日志被忽略
  }

  let levelTag = '';
  for (const key in LOG_LEVELS) {
    if (LOG_LEVELS[key] === level) {
      levelTag = `[${key}]`.padEnd(11, ' '); // e.g., "[DISCOVERY] "
      break;
    }
  }

  const formattedMessage = `${getTimestamp()} ${levelTag}${message}`;

  // 同时输出到控制台和文件
  console.log(formattedMessage);
  if (logStream) {
    logStream.write(formattedMessage + '\n');
  }
}

/**
 * 关闭日志文件流。
 * 必须在脚本结束时调用。
 */
function close() {
  if (logStream) {
    logStream.end();
    logStream = null;
    console.log('[Logger] 日志文件流已关闭。');
  }
}

module.exports = { 
  log, 
  init, 
  close,
  LOG_LEVELS // 导出级别定义，方便其他模块使用
};