// browser-script.js
// (v2: Performance Timing & Cache Logic)

/**
 * 这是一个在浏览器环境中执行的脚本。
 * 它实现了一个带路径缓存、自动回退和性能计时的智能数据提取器。
 * @param {object} options - 包含配置的对象
 */
function initializeExtractor(options) {
  const { selectors, interval, desiredFields, config } = options;

  let cachedPath = null;

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

  const deepSearchForArray = (obj, path, visited) => {
    if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = obj[key];
        const newPath = `${path}.${key}`;
        if (isMarketDataArray(value)) {
          return { data: value, path: newPath };
        }
        if (typeof value === 'object') {
          const result = deepSearchForArray(value, newPath, visited);
          if (result) return result;
        }
      }
    }
    return null;
  };

  const extractData = () => {
    const startTime = performance.now(); // ✨ 开始计时
    
    const targetElement = document.querySelector(selectors.stableContainer);
    if (!targetElement) return;
    let rootFiber = getReactFiber(targetElement);
    if (!rootFiber) return;

    let dataArray = null;
    let foundPath = null;
    let cacheHit = false; // ✨ 默认缓存未命中

    // 1. 尝试使用缓存路径
    if (cachedPath) {
      const potentialData = getNestedValue(rootFiber, cachedPath);
      if (isMarketDataArray(potentialData)) {
        dataArray = potentialData;
        foundPath = cachedPath;
        cacheHit = true; // ✨ 标记缓存命中
      } else {
        cachedPath = null;
      }
    }

    // 2. 如果缓存无效，执行启发式搜索
    if (!dataArray) {
      let currentFiber = rootFiber;
      let depth = 0;
      while (currentFiber && depth < config.maxFiberTreeDepth) {
        const fiberPathPrefix = 'fiber' + (depth > 0 ? '.return'.repeat(depth) : '');
        const result = deepSearchForArray(currentFiber.memoizedProps, `${fiberPathPrefix}.memoizedProps`, new Set()) ||
                       deepSearchForArray(currentFiber.memoizedState, `${fiberPathPrefix}.memoizedState`, new Set());
        
        if (result) {
          dataArray = result.data;
          foundPath = result.path.replace(/^fiber\./, '');
          cachedPath = foundPath;
          console.log(`[Extractor] Path cache MISS. New path found and cached: ${cachedPath}`);
          break;
        }
        currentFiber = currentFiber.return;
        depth++;
      }
    }

    const endTime = performance.now(); // ✨ 结束计时
    const duration = (endTime - startTime).toFixed(2); // 计算耗时，保留两位小数

    // 3. 发送数据和性能信息
    if (dataArray) {
      const filteredData = dataArray.map(item => {
        const newItem = {};
        for (const field of desiredFields) {
          newItem[field] = item[field];
        }
        return newItem;
      });
      // ✨ 发送包含耗时和缓存状态的完整结果
      window.onDataExtracted({ data: filteredData, path: foundPath, duration: duration, cacheHit: cacheHit });
    }
  };

  setInterval(extractData, interval);
  console.log(`✅ Smart Extractor initialized. Interval: ${interval}ms. Caching & Timing enabled.`);
  extractData();
}