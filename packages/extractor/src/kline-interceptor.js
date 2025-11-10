// packages/extractor/src/kline-interceptor.js
(() => {
  if (window.isWsInterceptorReady) {
    return;
  }
  
  // 依赖于 investigator 脚本预先注入的 window.originalConsoleLog
  const safeLog = window.originalConsoleLog || console.log;
  
  safeLog('✅ [Interceptor v3.1 - Fused] 注入成功！将使用 originalConsoleLog 进行输出。');

  function bufferToHex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('');
  }

  const OriginalWebSocket = window.WebSocket;

  (function() {
    let internalWs;
    
    const LoggingWebSocket = function(url, protocols) {
      safeLog(`[WebSocket] 正在尝试建立连接: ${url}`);
      const wsInstance = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);

      const originalSend = wsInstance.send;
      wsInstance.send = function(data) {
        let logData = data;
        try { logData = JSON.parse(data); } catch (e) {}
        safeLog('➡️ [SEND]', logData); 
        return originalSend.call(this, data);
      };

      wsInstance.addEventListener('message', (event) => {
        const data = event.data;
        if (typeof data === 'string') {
          safeLog('⬅️ [RECV TEXT]', data);
        } else if (data instanceof ArrayBuffer) {
          safeLog('⬅️ [RECV BINARY]', `(length: ${data.byteLength})`, bufferToHex(data));
        } else {
          safeLog('⬅️ [RECV UNKNOWN]', data);
        }
      });
      
      wsInstance.addEventListener('open', () => safeLog(`[WebSocket] 连接已打开: ${url}`));
      wsInstance.addEventListener('close', (event) => safeLog(`[WebSocket] 连接已关闭: (code: ${event.code})`));
      wsInstance.addEventListener('error', () => safeLog(`[WebSocket] 发生错误`)); // 也可以用 safeError

      return wsInstance;
    };
    
    Object.defineProperty(window, 'WebSocket', {
      get: function() {
        return internalWs || LoggingWebSocket;
      },
      set: function(newValue) {
        safeLog('[Interceptor] WARNING: 有代码正在尝试重写 window.WebSocket！');
        internalWs = newValue;
      },
      configurable: true,
      enumerable: true
    });
  })();

  window.isWsInterceptorReady = true;
  safeLog('✅ [Interceptor v3.1 - Fused] 劫持逻辑部署完毕。');
})();