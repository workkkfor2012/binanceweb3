// browser-script.js

// (v3.7: Detailed Performance Logging)

/**
 * v3.7: 增加详细的性能日志，拆分读取和Diff耗时，并统计处理数量。
 */
function initializeExtractor(options) {
  const { selectors, interval, config, desiredFields } = options;

  // 定义一个安全的日志函数
  const safeLog = (...args) => {
    if (window.originalConsoleLog) {
      window.originalConsoleLog(...args);
    } else {
      console.log(...args);
    }
  };

  let cachedPath = null;
  let dataStateCache = {};
  let lastExecutionTime = 0;
  const YIELD_THRESHOLD = 200;

  // --- 辅助函数 (内容不变) ---
  const getReactFiber = (element) => {
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    return element[key];
  };

  const isMarketDataArray = (arr) => {
    if (!Array.isArray(arr) || arr.length < config.minArrayLength) return false;
    const item = arr[0];
    if (typeof item !== 'object' || item === null) return false;
    const keys = Object.keys(item);
    return config.requiredKeys.every(key => keys.includes(key));
  };

  const getNestedValue = (obj, path) => {
    try {
      return path.split('.').reduce((acc, key) => acc && acc[key], obj);
    } catch (e) {
      return null;
    }
  };

  const asyncDeepSearchForArray = async (obj, path, visited) => {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);

    let yieldCounter = 0;
    const keys = Object.keys(obj);

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (++yieldCounter > YIELD_THRESHOLD) {
          await new Promise(resolve => setTimeout(resolve, 0));
          yieldCounter = 0;
        }

        const value = obj[key];
        const newPath = `${path}.${key}`;
        if (isMarketDataArray(value)) {
          return { data: value, path: newPath };
        }
        if (typeof value === 'object') {
          const result = await asyncDeepSearchForArray(value, newPath, visited);
          if (result) return result;
        }
      }
    }
    return null;
  };

  const areObjectsDifferent = (oldObj, newObj) => {
    for (const field of desiredFields) {
      if (oldObj[field] !== newObj[field]) {
        return true;
      }
    }
    return false;
  };
  // --- 辅助函数结束 ---

  const extractData = async () => {
    const startTime = performance.now();
    
    const targetElement = document.querySelector(selectors.stableContainer);
    if (!targetElement) return;
    let rootFiber = getReactFiber(targetElement);
    if (!rootFiber) return;

    let dataArray = null;
    let foundPath = null;
    let cacheHit = false;

    if (cachedPath) {
      const potentialData = getNestedValue(rootFiber, cachedPath);
      if (isMarketDataArray(potentialData)) {
        dataArray = potentialData;
        foundPath = cachedPath;
        cacheHit = true;
      } else {
        cachedPath = null;
      }
    }

    if (!dataArray) {
      let currentFiber = rootFiber;
      let depth = 0;
      while (currentFiber && depth < config.maxFiberTreeDepth) {
        const fiberPathPrefix = 'fiber' + (depth > 0 ? '.return'.repeat(depth) : '');
        const result = (await asyncDeepSearchForArray(currentFiber.memoizedProps, `${fiberPathPrefix}.memoizedProps`, new Set())) ||
                       (await asyncDeepSearchForArray(currentFiber.memoizedState, `${fiberPathPrefix}.memoizedState`, new Set()));
        
        if (result) {
          dataArray = result.data;
          foundPath = result.path.replace(/^fiber\./, '');
          cachedPath = foundPath;
          break;
        }
        currentFiber = currentFiber.return;
        depth++;
      }
    }
    
    // ✨ ================== 核心变更：增加时间点和性能指标 ==================
    const readEndTime = performance.now();

    if (dataArray && dataArray.length > 0) {
      const firstItem = dataArray[0];
      if (firstItem && firstItem.price !== undefined) {
        const nowData = new Date();
        const dataTimestamp = `[${String(nowData.getMinutes()).padStart(2, '0')}:${String(nowData.getSeconds()).padStart(2, '0')}.${String(nowData.getMilliseconds()).padStart(3, '0')}]`;
        safeLog(`%c${dataTimestamp} [Price Read] ${firstItem.symbol}:`, 'color: cyan;', firstItem.price);
      }
      
      const changedData = [];
      const isFirstRun = Object.keys(dataStateCache).length === 0;
      const totalCount = dataArray.length; // 记录读取总数

      for (const item of dataArray) {
        const uniqueId = item.contractAddress;
        if (!uniqueId) continue;
        const oldItem = dataStateCache[uniqueId];
        if (isFirstRun || !oldItem || areObjectsDifferent(oldItem, item)) {
          const filteredItem = {};
          for (const field of desiredFields) {
            filteredItem[field] = item[field];
          }
          changedData.push(filteredItem);
          dataStateCache[uniqueId] = item;
        }
      }

      const diffEndTime = performance.now();
      const changedCount = changedData.length; // 记录变更数

      // 计算各阶段耗时
      const readDuration = (readEndTime - startTime).toFixed(2);
      const diffDuration = (diffEndTime - readEndTime).toFixed(2);
      const totalDuration = (diffEndTime - startTime).toFixed(2);
      
      const payload = {
        path: foundPath, 
        duration: totalDuration,
        readDuration,
        diffDuration,
        totalCount,
        changedCount,
        cacheHit: cacheHit,
      };

      if (changedCount > 0) {
        payload.data = changedData;
        payload.type = isFirstRun ? 'snapshot' : 'update';
        window.onDataExtracted(payload);
      } else {
        payload.type = 'no-change';
        window.onDataExtracted(payload);
      }
      // ✨ ====================================================================
    }
  };

  const extractionLoop = async (currentTime) => {
    requestAnimationFrame(extractionLoop);
    if (currentTime - lastExecutionTime > interval) {
      lastExecutionTime = currentTime;
      await extractData();
    }
  };

  safeLog(`✅ Smart Async Extractor initialized (v3.7). Performance logging to Node.js console is ENABLED.`);
  
  (async () => {
    await extractData();
    requestAnimationFrame(extractionLoop);
  })();
}