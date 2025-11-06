// packages/extractor/src/logger.ts
import * as fs from 'fs';
import * as path from 'path';

export const LOG_LEVELS = {
  DEBUG: 1,
  INFO: 2,
  DISCOVERY: 3,
  ERROR: 4,
};

const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;
// 路径调整为从 src 目录出发，日志仍在 packages/extractor/logs
const LOG_DIRECTORY = path.join(__dirname, '..', '..', 'logs');

let logStream: fs.WriteStream | null = null;

export function init(): void {
  if (!fs.existsSync(LOG_DIRECTORY)) {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
  }
  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-').slice(0, -5);
  const logFileName = `run_${timestamp}.log`;
  const logFilePath = path.join(LOG_DIRECTORY, logFileName);
  
  logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  console.log(`[Logger] 日志文件已创建: ${logFilePath}`);
}

function getTimestamp(): string {
  const now = new Date();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  return `[${minutes}:${seconds}.${milliseconds}]`;
}

export function log(message: string, level: number = LOG_LEVELS.INFO): void {
  if (level < CURRENT_LOG_LEVEL) {
    return;
  }

  let levelTag = '';
  for (const key in LOG_LEVELS) {
    if (LOG_LEVELS[key as keyof typeof LOG_LEVELS] === level) {
      levelTag = `[${key}]`.padEnd(11, ' ');
      break;
    }
  }

  const formattedMessage = `${getTimestamp()} ${levelTag}${message}`;
  console.log(formattedMessage);
  if (logStream) {
    logStream.write(formattedMessage + '\n');
  }
}

export function close(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
    console.log('[Logger] 日志文件流已关闭。');
  }
}