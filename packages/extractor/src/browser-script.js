// packages/extractor/src/browser-script.ts
/// <reference path="./global.d.ts" />

import type { MarketItem, ExtractedDataPayload } from 'shared-types';

interface ExtractorOptions {
  selectors: { stableContainer: string };
  interval: number;
  config: {
    minArrayLength: number;
    requiredKeys: string[];
    maxFiberTreeDepth: number;
  };
  desiredFields: string[];
}

function initializeExtractor(options: ExtractorOptions): void {
  const { selectors, interval, config, desiredFields } = options;

  const safeLog = (...args: any[]): void => {
    if (window.originalConsoleLog) {
      window.originalConsoleLog(...args);
    } else {
      console.log(...args);
    }
  };

  let cachedPath: string | null = null;
  let dataStateCache: { [key: string]: any } = {};
  let lastExecutionTime = 0;
  const YIELD_THRESHOLD = 200;

  const getReactFiber = (element: Element): any | null => {
    const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
    return key ? (element as any)[key] : null;
  };

  const isMarketDataArray = (arr: any): arr is MarketItem[] => {
    if (!Array.isArray(arr) || arr.length < config.minArrayLength) return false;
    const item = arr[0];
    if (typeof item !== 'object' || item === null) return false;
    const keys = Object.keys(item);
    return config.requiredKeys.every(key => keys.includes(key));
  };

  const getNestedValue = (obj: any, path: string): any | null => {
    try {
      return path.split('.').reduce((acc, key) => acc && acc[key], obj);
    } catch (e) {
      return null;
    }
  };

  const asyncDeepSearchForArray = async (
    obj: any,
    path: string,
    visited: Set<any>
  ): Promise<{ data: any[]; path: string } | null> => {
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

  const areObjectsDifferent = (oldObj: MarketItem, newObj: MarketItem): boolean => {
    for (const field of desiredFields) {
      if (oldObj[field] !== newObj[field]) {
        return true;
      }
    }
    return false;
  };

  const extractData = async (): Promise<void> => {
    const startTime = performance.now();
    
    const targetElement = document.querySelector<HTMLElement>(selectors.stableContainer);
    if (!targetElement) return;
    let rootFiber = getReactFiber(targetElement);
    if (!rootFiber) return;

    let dataArray: MarketItem[] | null = null;
    let foundPath: string | null = null;
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
      const changedData: MarketItem[] = [];
      const isFirstRun = Object.keys(dataStateCache).length === 0;
      const totalCount = dataArray.length;

      for (const item of dataArray) {
        const uniqueId = item.contractAddress;
        if (!uniqueId) continue;
        const oldItem = dataStateCache[uniqueId];
        if (isFirstRun || !oldItem || areObjectsDifferent(oldItem, item)) {
          const filteredItem: { [key: string]: any } = {};
          for (const field of desiredFields) {
            filteredItem[field] = item[field];
          }
          changedData.push(filteredItem as MarketItem);
          dataStateCache[uniqueId] = item;
        }
      }

      const diffEndTime = performance.now();
      const changedCount = changedData.length;

      const readDuration = (readEndTime - startTime).toFixed(2);
      const diffDuration = (diffEndTime - readEndTime).toFixed(2);
      const totalDuration = (diffEndTime - startTime).toFixed(2);
      
      const payload: ExtractedDataPayload = {
        path: foundPath, 
        duration: totalDuration,
        readDuration,
        diffDuration,
        totalCount,
        changedCount,
        cacheHit: cacheHit,
        type: 'no-change',
      };

      if (changedCount > 0) {
        payload.data = changedData;
        payload.type = isFirstRun ? 'snapshot' : 'update';
        window.onDataExtracted(payload);
      } else {
        payload.type = 'no-change';
        window.onDataExtracted(payload);
      }
    }
  };

  const extractionLoop = async (currentTime: number): Promise<void> => {
    requestAnimationFrame(extractionLoop);
    if (currentTime - lastExecutionTime > interval) {
      lastExecutionTime = currentTime;
      await extractData();
    }
  };

  safeLog(`✅ Smart Async Extractor initialized (TS). Performance logging to Node.js console is ENABLED.`);
  
  (async () => {
    await extractData();
    requestAnimationFrame(extractionLoop);
  })();
}