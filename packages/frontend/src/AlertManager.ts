


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
// --- 模块内部状态 ---
let availablePreferredVoices: SpeechSynthesisVoice[] = [];


// --- 核心功能 ---
// 核心功能
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

    // 如果正在说话，取消当前，播报最新的 (或者根据需求排队，此处保持打断逻辑以保证实时性)
    if (speechSynthesis.speaking) {
        speechSynthesis.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);

    if (availablePreferredVoices.length > 0) {
        const randomIndex = Math.floor(Math.random() * availablePreferredVoices.length);
        utterance.voice = availablePreferredVoices[randomIndex];
    } else {
        console.warn('[SpeakFlow] 未找到首选声音，将使用浏览器默认声音。');
    }

    utterance.lang = utterance.voice?.lang ?? 'zh-CN';
    utterance.rate = 1.1;
    utterance.pitch = 1;

    utterance.onstart = () => console.log(`[SpeakFlow] Event: onstart - 播报 "${text}" 已开始。`);
    utterance.onerror = (event) => console.error(`[SpeakFlow] Event: onerror - 播报失败!`, event);

    speechSynthesis.speak(utterance);
}
