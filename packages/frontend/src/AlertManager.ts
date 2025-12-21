// packages/frontend/src/AlertManager.ts
import type { MarketItem } from 'shared-types';

// --- ⚙️ 配置区 ---
const PREFERRED_VOICE_NAMES: string[] = [
    "Microsoft Huihui - Chinese (Simplified, PRC)",
    "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)",
    "Microsoft Xiaoyi Online (Natural) - Chinese (Mainland)",
    "Microsoft Yunjian Online (Natural) - Chinese (Mainland)",
    "Microsoft Yunxi Online (Natural) - Chinese (Mainland)",
    "Microsoft Yunxia Online (Natural) - Chinese (Mainland)",
    "Microsoft Yunyang Online (Natural) - Chinese (Mainland)",
    "Microsoft Xiaobei Online (Natural) - Chinese (Northeastern Mandarin)",
    "Microsoft HsiaoChen Online (Natural) - Chinese (Taiwan)",
    "Microsoft YunJhe Online (Natural) - Chinese (Taiwan)",
    "Microsoft HsiaoYu Online (Natural) - Chinese (Taiwanese Mandarin)",
    "Microsoft Xiaoni Online (Natural) - Chinese (Zhongyuan Mandarin Shaanxi)"
];
const ALERT_THRESHOLDS = {
    volume1m: 50,
    volume5m: 200,
    priceChange1m: 5,
    priceChange5m: 25,
    // ✨ 新增: 为价格波动提醒增加成交额门槛，避免无量波动产生的无效提醒
    priceChangeVolume1m_min: 20, // 1分钟价格异动所需的最小成交额
    priceChangeVolume5m_min: 100, // 5分钟价格异动所需的最小成交额
};
const COOLDOWN_PERIOD_MS = 1000 * 60;

// --- 模块内部状态 ---
let availablePreferredVoices: SpeechSynthesisVoice[] = [];
const alertCooldowns = new Map<string, number>();

// --- 核心功能 ---
export function initializeVoices(): void {
    if (!('speechSynthesis' in window)) {
        console.warn("[AlertManager] 此浏览器不支持 Web Speech API。");
        return;
    }
    const loadVoices = () => {
        const allVoices = speechSynthesis.getVoices();
        availablePreferredVoices = allVoices.filter(voice => PREFERRED_VOICE_NAMES.includes(voice.name));
        console.log(`[AlertManager] 声音列表已加载, 找到 ${availablePreferredVoices.length} 个匹配的首选声音。`);
    };
    loadVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = loadVoices;
    }
}

export function speak(text: string): void {
    console.log(`[SpeakFlow] 收到请求，准备播报: "${text}"`);

    if (speechSynthesis.speaking) {
        console.log('[SpeakFlow] 当前正在播报，将执行 cancel() 来打断。');
        speechSynthesis.cancel();
    } else {
        console.log('[SpeakFlow] 当前无播报，直接执行。');
    }

    const utterance = new SpeechSynthesisUtterance(text);

    if (availablePreferredVoices.length > 0) {
        const randomIndex = Math.floor(Math.random() * availablePreferredVoices.length);
        utterance.voice = availablePreferredVoices[randomIndex];
        console.log(`[SpeakFlow] 已选择声音: ${utterance.voice.name}`);
    } else {
        console.warn('[SpeakFlow] 未找到首选声音，将使用浏览器默认声音。');
    }

    utterance.lang = utterance.voice?.lang ?? 'zh-CN';
    utterance.rate = 1.1;
    utterance.pitch = 1;
    console.log('[SpeakFlow] Utterance 配置完成:', { lang: utterance.lang, rate: utterance.rate, voice: utterance.voice?.name });

    utterance.onstart = () => console.log(`[SpeakFlow] Event: onstart - 播报 "${text}" 已开始。`);
    utterance.onend = () => console.log(`[SpeakFlow] Event: onend - 播报 "${text}" 已结束。`);
    utterance.onerror = (event) => console.error(`[SpeakFlow] Event: onerror - 播报失败!`, event);

    console.log('[SpeakFlow] 调用 speechSynthesis.speak() ...');
    speechSynthesis.speak(utterance);
}

function canAlert(id: string, type: string): boolean {
    const key = `${id}-${type}`;
    const lastAlertTime = alertCooldowns.get(key);
    const now = Date.now();
    const isAllowed = !lastAlertTime || (now - lastAlertTime > COOLDOWN_PERIOD_MS);

    console.log(`[AlertFlow] [Cooldown Check] Key: ${key}, Last Alert: ${lastAlertTime ? new Date(lastAlertTime).toLocaleTimeString() : 'N/A'}, Allowed: ${isAllowed}`);

    if (isAllowed) {
        alertCooldowns.set(key, now);
        return true;
    }
    return false;
}

export function checkAndTriggerAlerts(
    newItem: MarketItem,
    oldItem: MarketItem | undefined,
    onAlert: (logMessage: string, alertType: 'volume' | 'price') => void
): void {
    if (!oldItem) return;

    //console.log(`[AlertFlow] --- 检查提醒 for ${newItem.symbol} ---`);

    const { contractAddress, symbol, volume1m, volume5m, priceChange1m, priceChange5m } = newItem;
    let message = '';

    // 规则 1: 1分钟成交额
    if (volume1m > ALERT_THRESHOLDS.volume1m && canAlert(contractAddress, 'volume1m')) {
        const volumeText = `${Math.round(volume1m / 10000)}万`;
        message = `${symbol} 1分钟 ${volumeText}`;
        console.log(`[AlertFlow] [PASSED] 规则 "volume1m" 满足条件, 准备触发提醒。`);
        speak(message);
        onAlert(message, 'volume');
    }

    // 规则 2: 5分钟成交额
    if (volume5m > ALERT_THRESHOLDS.volume5m && canAlert(contractAddress, 'volume5m')) {
        const volumeText = `${Math.round(volume5m / 10000)}万`;
        message = `${symbol} 5分钟 ${volumeText}`;
        console.log(`[AlertFlow] [PASSED] 规则 "volume5m" 满足条件, 准备触发提醒。`);
        speak(message);
        onAlert(message, 'volume');
    }

    // 规则 3: 1分钟价格变化 (增加成交额过滤)
    const pc1m = parseFloat(String(priceChange1m));
    if (
        Math.abs(pc1m) > ALERT_THRESHOLDS.priceChange1m &&
        volume1m > ALERT_THRESHOLDS.priceChangeVolume1m_min && // 核心修改
        canAlert(contractAddress, 'priceChange1m')
    ) {
        const direction = pc1m > 0 ? '上涨' : '下跌';
        const changeText = `${Math.abs(pc1m).toFixed(1)}%`;
        message = `${symbol} 1分钟${direction}${changeText}`;
        console.log(`[AlertFlow] [PASSED] 规则 "priceChange1m" 满足条件 (成交额 > ${ALERT_THRESHOLDS.priceChangeVolume1m_min}), 准备触发提醒。`);
        speak(message);
        onAlert(message, 'price');
    }

    // 规则 4: 5分钟价格变化 (增加成交额过滤)
    const pc5m = parseFloat(String(priceChange5m));
    if (
        Math.abs(pc5m) > ALERT_THRESHOLDS.priceChange5m &&
        volume5m > ALERT_THRESHOLDS.priceChangeVolume5m_min && // 核心修改
        canAlert(contractAddress, 'priceChange5m')
    ) {
        const direction = pc5m > 0 ? '上涨' : '下跌';
        const changeText = `${Math.abs(pc5m).toFixed(1)}%`;
        message = `${symbol} 5分钟${direction}${changeText}`;
        console.log(`[AlertFlow] [PASSED] 规则 "priceChange5m" 满足条件 (成交额 > ${ALERT_THRESHOLDS.priceChangeVolume5m_min}), 准备触发提醒。`);
        speak(message);
        onAlert(message, 'price');
    }
}