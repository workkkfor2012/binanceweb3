// browser-script.js
// (v3.0: Diffing Observer)

/**
 * 这是一个在浏览器环境中执行的脚本。
 * 它实现了一个带路径缓存、自动回退和性能计时的智能数据提取器，
 * 并加入了变更检测（Diffing）逻辑，只在数据变化时才发送更新。
 */
function initializeExtractor(options) {
  const { selectors, interval, config, desiredFields } = options;

  let cachedPath = null;
  // ✨ 核心变更：用于存储数据状态的缓存，键为合约地址，值为上一次的数据对象
  let dataStateCache = {};

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

  // ✨ 新增辅助函数：比较两个对象指定的字段是否不同
  const areObjectsDifferent = (oldObj, newObj) => {
    for (const field of desiredFields) {
      if (oldObj[field] !== newObj[field]) {
        return true; // 只要有一个字段不同，就认为对象已改变
      }
    }
    return false;
  };

  const extractData = () => {
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
        const result = deepSearchForArray(currentFiber.memoizedProps, `${fiberPathPrefix}.memoizedProps`, new Set()) ||
                       deepSearchForArray(currentFiber.memoizedState, `${fiberPathPrefix}.memoizedState`, new Set());
        
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

    const endTime = performance.now();
    const duration = (endTime - startTime).toFixed(2);

    if (dataArray) {
      // ✨ 核心变更：执行变更检测 (Diffing)
      const changedData = [];
      const isFirstRun = Object.keys(dataStateCache).length === 0;

      for (const item of dataArray) {
        // 使用 contractAddress 作为唯一标识符
        const uniqueId = item.contractAddress;
        if (!uniqueId) continue;

        const oldItem = dataStateCache[uniqueId];

        // 如果是首次运行，或者数据发生了变化，则记录
        if (isFirstRun || !oldItem || areObjectsDifferent(oldItem, item)) {
          const filteredItem = {};
          for (const field of desiredFields) {
            filteredItem[field] = item[field];
          }
          changedData.push(filteredItem);
          dataStateCache[uniqueId] = item; // 更新状态缓存
        }
      }

      // 只有当有数据变化时才发送
      if (changedData.length > 0) {
        window.onDataExtracted({ 
          data: changedData, 
          path: foundPath, 
          duration: duration, 
          cacheHit: cacheHit,
          // ✨ 新增字段，告知接收方这是首次快照还是增量更新
          type: isFirstRun ? 'snapshot' : 'update'
        });
      }
    }
  };

  setInterval(extractData, interval);
  console.log(`✅ Smart Diffing Extractor initialized. Interval: ${interval}ms. Change detection enabled.`);
  extractData(); // 立即执行一次以获取初始快照
}