// packages/extractor/src/browser-script.js
/**
 * @typedef {object} MarketItem
 * @property {string} contractAddress
 * @property {string} symbol
 * @property {string} icon
 * @property {number} price
 * @property {string} priceChange24h
 * @property {number} volume24h
 * @property {number} marketCap
 */

/**
 * @typedef {object} ExtractedDataPayload
 * @property {'snapshot' | 'update' | 'no-change'} type
 * @property {MarketItem[]} [data]
 * @property {string | null} path
 * @property {string} duration
 * @property {string} readDuration
 * @property {string} diffDuration
 * @property {number} totalCount
 * @property {number} changedCount
 * @property {boolean} cacheHit
 */

/**
 * @typedef {object} ExtractorOptions
 * @property {{ stableContainer: string }} selectors
 * @property {number} interval
 * @property {{ minArrayLength: number, requiredKeys: string[], maxFiberTreeDepth: number }} config
 * @property {string[]} desiredFields
 */

/**
 * 初始化并运行数据提取器。
 * 此函数将在浏览器的上下文中执行，并挂载到 window 对象上。
 * @param {ExtractorOptions} options
 */
window.initializeExtractor = function(options) {
  const { selectors, interval, config, desiredFields } = options;

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

  // --- 辅助函数 ---
  const getReactFiber = (element) => {
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    return key ? element[key] : null;
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

  const asyncDeepSearchForArray = async (
    obj,
    path,
    visited
  ) => {
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
    
    const readEndTime = performance.now();

    if (dataArray && dataArray.length > 0) {
      const changedData = [];
      const isFirstRun = Object.keys(dataStateCache).length === 0;
      const totalCount = dataArray.length;

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
      const changedCount = changedData.length;

      const readDuration = (readEndTime - startTime).toFixed(2);
      const diffDuration = (diffEndTime - readEndTime).toFixed(2);
      const totalDuration = (diffEndTime - startTime).toFixed(2);
      
      /** @type {ExtractedDataPayload} */
      const payload = {
        path: foundPath, 
        duration: totalDuration,
        readDuration,
        diffDuration,
        totalCount,
        changedCount,
        cacheHit: cacheHit,
        type: 'no-change', // default
      };

      if (changedCount > 0) {
        payload.data = changedData;
        payload.type = isFirstRun ? 'snapshot' : 'update';
        window.onDataExtracted(payload);
      } else {
        // 即使没有变更，也发送性能数据
        window.onDataExtracted(payload);
      }
    }
  };

  const extractionLoop = (currentTime) => {
    requestAnimationFrame(extractionLoop);
    if (currentTime - lastExecutionTime > interval) {
      lastExecutionTime = currentTime;
      extractData();
    }
  };

  safeLog(`✅ Smart Async Extractor initialized (JS version).`);
  
  // 立即执行一次以获取快照，然后启动循环
  extractData().then(() => {
      requestAnimationFrame(extractionLoop);
  });
}