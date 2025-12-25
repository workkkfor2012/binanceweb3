// packages/frontend/src/MemePage.tsx
import { Component, createMemo, For, Show, onMount, createSignal, onCleanup, createEffect } from 'solid-js';
import { useMarketData } from './hooks/useMarketData.js';
import type { MemeItem, MarketItem } from './types.js';
import SingleKlineChart from './SingleKlineChart.jsx';
import { PRESET_THEMES } from './themes.js';
import { speak, initializeVoices } from './AlertManager.js';

import { MARKET_BACKEND_URL, marketSocket } from './socket.js';

declare global {
    interface Window {
        twttr: any;
    }
}

// ✨ 全局状态：控制是否显示 K 线
// 定义在组件外部，避免 Prop Drilling，所有卡片同时切换
const [showKline, setShowKline] = createSignal(false);
// ✨ 懒加载控制：只有用户第一次请求 K 线后，才开始渲染组件
const [chartsInitialized, setChartsInitialized] = createSignal(false);

interface MemeCardProps {
    item: MemeItem;
}

interface ColumnProps {
    title: string;
    items: MemeItem[];
    count: number;
}

// --- 辅助函数 ---

// ID 提取 (支持 x.com 和 twitter.com)
const extractTweetId = (input: string | undefined | null): string | null => {
    if (!input) return null;
    const str = String(input).trim();
    if (/^\d+$/.test(str)) return str;
    const match = str.match(/status\/(\d+)/);
    if (match && match[1]) return match[1];
    return null;
};

// 时间格式化
const formatTime = (ts: number | undefined) => {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

// 数值格式化 (1.2M, 500k)
const formatNumber = (num: number | undefined | null) => {
    if (num === undefined || num === null) return '-';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return num.toFixed(0);
};

// 计算“发射耗时” (Bonding Speed)
const getBondingDuration = (item: MemeItem): { text: string; color: string; icon: string } | null => {
    if (!item.migrateTime || !item.createTime || item.migrateTime <= 0 || item.createTime <= 0) return null;
    if (item.migrateTime < item.createTime) return null;

    const diffMs = item.migrateTime - item.createTime;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 30) return { text: `${diffMins}m`, color: '#dc3545', icon: '🔥' }; // 极速
    if (diffHours < 2) return { text: `${diffMins}m`, color: '#fd7e14', icon: '⚡' }; // 快速
    if (diffHours < 24) return { text: `${diffHours}h`, color: '#6c757d', icon: '⏱' }; // 普通
    return { text: '>1d', color: '#6c757d', icon: '🐢' }; // 龟速
};

// --- 推特组件 ---
const TweetEmbed: Component<{ tweetId: string; }> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    const [isLoaded, setIsLoaded] = createSignal(false);

    onMount(() => {
        if (!props.tweetId) return;
        if (!window.twttr) {
            const script = document.createElement('script');
            script.src = 'https://platform.twitter.com/widgets.js';
            script.async = true;
            document.head.appendChild(script);
        }

        const renderTweet = () => {
            if (window.twttr && window.twttr.widgets && containerRef) {
                containerRef.innerHTML = '';
                window.twttr.widgets.createTweet(
                    props.tweetId,
                    containerRef,
                    {
                        theme: 'light',
                        lang: 'zh-cn',
                        dnt: true,
                        conversation: 'none',
                        cards: 'visible',
                        width: 'auto',
                        align: 'center'
                    }
                ).then((el: any) => {
                    if (el) setIsLoaded(true);
                    else containerRef!.innerHTML = `<div style="color:#ccc; font-size:11px; padding:10px; text-align:center;">Tweet unavailable</div>`;
                });
            } else {
                setTimeout(renderTweet, 200);
            }
        };
        renderTweet();
    });

    return (
        <div
            class="tweet-embed-wrapper"
            style={{
                "min-height": isLoaded() ? "auto" : "150px",
                "width": "100%",
                "background": isLoaded() ? "transparent" : "#f8f9fa",
                "border-radius": "8px",
                "display": "flex",
                "justify-content": "center",
                "align-items": "center",
                "margin-top": "8px",
                "border": isLoaded() ? "none" : "1px dashed #e1e4e8"
            }}
        >
            <div ref={containerRef} style={{ width: '100%', display: 'flex', "justify-content": 'center' }}>
                <span style={{ color: '#aaa', "font-size": '11px' }}>Loading Tweet...</span>
            </div>
        </div>
    );
};

// --- 卡片组件 ---
const MemeCard: Component<MemeCardProps> = (props) => {
    const { item } = props;
    const cleanTwitterId = createMemo(() => extractTweetId(item.twitter));
    const iconUrl = item.icon ? `${MARKET_BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon)}&symbol=${encodeURIComponent(item.symbol)}` : '';
    const bondingSpeed = createMemo(() => getBondingDuration(item));

    // ✨ 按需请求叙事逻辑
    createEffect(() => {
        if (!item.narrative && item.contractAddress && item.chain) {
            marketSocket.emit('request_narrative', {
                address: item.contractAddress,
                chain: item.chain,
                interval: '1m' // 随便传个 interval 适配结构体
            });
        }
    });

    onMount(() => {
        // useMarketData 已经通过全局 marketSocket 监听 narrative_response 并更新 store 了
    });

    const handleCardClick = () => {
        window.open(`/token.html?address=${item.contractAddress}&chain=${item.chain}`, '_blank');
    };

    const handleContentClick = (e: MouseEvent) => e.stopPropagation();

    // 转换类型以适配 SingleKlineChart
    const marketItem: MarketItem = {
        ...item,
        price: (item as any).price || 0,
        priceChange24h: (item as any).priceChange24h || 0,
        volume24h: (item as any).volume24h || 0,
        source: 'meme_card'
    } as any;

    return (
        <div class="meme-card" onClick={handleCardClick} style={{ "min-height": "350px", "display": "flex", "flex-direction": "column" }}>
            {/* Header Area */}
            <div class="card-header-layout">
                <Show when={item.icon} fallback={<div style={{ width: '42px', height: '42px', background: '#eee', borderRadius: '50%' }}></div>}>
                    <img
                        src={iconUrl}
                        class="card-icon"
                        loading="lazy"
                        onError={(e) => {
                            // console.error(`[IconError] Symbol: ${item.symbol} | URL: ${e.currentTarget.src}`);
                            e.currentTarget.style.display = 'none';
                        }}
                    />
                </Show>

                <div class="card-info-col">
                    {/* Row 1: Symbol, Name, Flags | Speed, Time */}
                    <div style={{ display: 'flex', "justify-content": 'space-between', "align-items": 'center' }}>

                        {/* 左侧信息组：Symbol + AD + Name (截断) */}
                        <div style={{ display: 'flex', "align-items": 'center', gap: '6px', overflow: 'hidden', flex: '1', "padding-right": '8px' }}>
                            {/* Symbol */}
                            <span class="card-symbol" title={item.symbol} style={{ flexShrink: 0 }}>{item.symbol}</span>

                            {/* Paid AD Tag (放在名字前面，保证重要信息可见) */}
                            <Show when={item.paidOnDexScreener}>
                                <span title="Paid AD on DexScreener" style={{ "font-size": '0.6em', background: '#ffd700', color: '#856404', padding: '1px 3px', "border-radius": '3px', border: '1px solid #ffeeba', "font-weight": 'bold', "flex-shrink": 0 }}>
                                    AD
                                </span>
                            </Show>

                            {/* ✨ Name: 浅色显示，过长自动省略 */}
                            <span
                                style={{
                                    color: '#999',
                                    "font-size": '0.8em',
                                    "white-space": 'nowrap',
                                    overflow: 'hidden',
                                    "text-overflow": 'ellipsis',
                                    "font-weight": 'normal',
                                    "margin-top": '2px' // 视觉微调，对齐基线
                                }}
                                title={item.name}
                            >
                                {item.name}
                            </span>
                        </div>

                        {/* 右侧信息组：速度 + 时间 */}
                        <div style={{ display: 'flex', "align-items": 'center', gap: '5px', "flex-shrink": 0 }}>
                            {/* Bonding Speed Badge */}
                            <Show when={bondingSpeed()}>
                                <span style={{
                                    "font-size": '0.7em',
                                    color: bondingSpeed()!.color,
                                    "font-weight": 'bold',
                                    display: 'flex',
                                    "align-items": 'center',
                                    background: `${bondingSpeed()!.color}15`,
                                    padding: '1px 5px',
                                    "border-radius": '4px'
                                }} title="从发币到迁移的耗时">
                                    {bondingSpeed()!.icon} {bondingSpeed()!.text}
                                </span>
                            </Show>
                            <span class="card-time">{formatTime(item.migrateTime || item.createTime || Date.now())}</span>
                        </div>
                    </div>

                    {/* Row 2: Stats (MC, Liq, Buys/Sells, Holders) */}
                    <div class="info-row-bottom" style={{ gap: '4px', "flex-wrap": 'wrap' }}>

                        {/* 1. 市值 (MC) */}
                        <span class="stat-badge badge-cap" title={`Market Cap: $${item.marketCap}`}>
                            MC ${formatNumber(item.marketCap)}
                        </span>

                        {/* 2. 流动性 (Liq) */}
                        <Show when={item.liquidity}>
                            <span class="stat-badge" style={{ background: '#e3fafc', color: '#0c8599', "border-color": '#99e9f2' }} title={`Liquidity: $${item.liquidity}`}>
                                💧 ${formatNumber(item.liquidity)}
                            </span>
                        </Show>

                        {/* 3. 买卖单数 */}
                        <Show when={item.countBuy !== undefined && item.countSell !== undefined}>
                            <span class="stat-badge" title={`Buys: ${item.countBuy} / Sells: ${item.countSell}`}>
                                <span style={{ color: '#28a745', "font-weight": 'bold' }}>{item.countBuy}</span>
                                <span style={{ opacity: 0.3, margin: '0 2px' }}>/</span>
                                <span style={{ color: '#dc3545', "font-weight": 'bold' }}>{item.countSell}</span>
                            </span>
                        </Show>

                        {/* 4. 持有人数 */}
                        <span class="stat-badge">👥 {item.holders || '-'}</span>

                        {/* 5. 狙击手警告 */}
                        <Show when={(item.holdersSniperPercent || 0) > 50}>
                            <span class="stat-badge" style={{ background: '#fff5f5', color: '#e03131', "border-color": '#ffc9c9' }} title={`Sniper Holdings: ${item.holdersSniperPercent}%`}>
                                🎯 {Math.round(item.holdersSniperPercent!)}%
                            </span>
                        </Show>

                        {/* 6. 开发者历史 */}
                        <Show when={(item.devMigrateCount || 0) > 0}>
                            <span class="stat-badge badge-dev">Dev:{item.devMigrateCount}</span>
                        </Show>
                    </div>
                </div>
            </div>

            {/* ✨ 内容区域：层叠布局 (Stacking Context) */}
            <div
                class="card-content-area"
                style={{
                    flex: '1',
                    position: 'relative',
                    "min-height": "0",
                    "display": "flex",
                    "flex-direction": "column"
                }}
            >
                {/* 
                    Layer 1: Info Layer (Narrative + Tweet)
                    - 当 showKline=true 时，隐藏 (display: none)
                    - 否则显示 (display: flex)
                */}
                <div
                    class="layer-info"
                    style={{
                        display: showKline() ? 'none' : 'flex',
                        "flex-direction": "column",
                        "flex": "1",
                        "width": "100%"
                    }}
                >
                    {/* Narrative Text */}
                    <Show when={item.narrative}>
                        <div class="card-narrative-box" onClick={handleContentClick} style={{ "max-height": "100px", "overflow-y": "auto" }}>
                            {item.narrative}
                        </div>
                    </Show>

                    {/* Tweet Embed (推特模式) */}
                    <Show when={cleanTwitterId()}>
                        <div onClick={handleContentClick} style={{ width: '100%', overflow: 'hidden', "margin-top": "auto" }}>
                            <TweetEmbed tweetId={cleanTwitterId()!} />
                        </div>
                    </Show>
                </div>

                {/* 
                    Layer 2: Chart Layer
                    - 当 showKline=true 时，显示 (display: block)
                    - 当 showKline=false 时，隐藏 (display: none)
                    - 使用 chartsInitialized() 进行懒加载，第一次请求前不渲染 DOM
                */}
                <div
                    class="layer-chart"
                    style={{
                        display: showKline() ? 'block' : 'none',
                        width: '100%',
                        height: '100%',
                        "min-height": "250px", // 确保高度撑开
                        "flex": "1" // 填充剩余空间
                    }}
                    onClick={handleContentClick}
                >
                    <Show when={chartsInitialized()}>
                        <SingleKlineChart
                            tokenInfo={marketItem}
                            timeframe="1m" // 默认 1m 看局部
                            theme={PRESET_THEMES[0]} // 使用亮色主题
                            viewportState={null}
                            activeChartId={null}
                            showAxes={true} // 简略模式不显示坐标轴，或者显示
                            simpleMode={true} // ✨ 开启简约模式，隐藏 Header，避免 Resize 问题
                        />
                    </Show>
                </div>
            </div>

            {/* Bonding Curve Progress Bar */}
            <div class="card-bonding-line" title={`Bonding Curve: ${item.progress?.toFixed(1)}%`} style={{ "margin-top": "8px" }}>
                <div
                    class="bonding-fill"
                    style={{
                        width: `${Math.min(item.progress || 0, 100)}%`,
                        "background-color": (item.progress || 0) > 90 ? '#28a745' : '#007bff'
                    }}
                ></div>
            </div>
        </div>
    );
};

// --- Column Component ---
const MemeColumn: Component<ColumnProps> = (props) => {
    return (
        <div class="meme-column">
            <div class="column-header">
                <span>{props.title}</span>
                <span class="column-badge" style={{ background: '#dce4ea', padding: '2px 8px', "border-radius": '10px', "font-size": '0.85em' }}>
                    {props.count}
                </span>
            </div>
            <div class="column-content">
                <For each={props.items}>
                    {(item) => <MemeCard item={item} />}
                </For>
                <Show when={props.items.length === 0}>
                    <div style={{ "text-align": 'center', padding: '50px 0', color: '#999', "font-size": '0.9em', "grid-column": '1 / -1' }}>
                        Waiting for data...
                    </div>
                </Show>
            </div>
        </div>
    );
};

// --- Main Page Component ---
const MemePage: Component = () => {
    const [marketData, setMarketData] = createStore<T[]>([]);
    const [alertLogs, setAlertLogs] = createStore<ServerAlertEntry[]>([]); // ✨ 升级为详细日志
    const [connectionStatus, setConnectionStatus] = createSignal('Connecting...');
    const [lastUpdate, setLastUpdate] = createSignal('N/A');
    // const [blockList] = createSignal(loadBlockListFromStorage()); // Unused logic kept but commented out to fix lint

    // 1. 按 Liquidity 排序前 9 名 (High to Low)
    const topLiquidityTokens = createMemo(() => {
        const sorted = marketData
            .slice()
            .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
        return sorted.slice(0, 9);
    });

    // 2. 按最近发射时间排序前 9 名 (Newest First)
    const recentTokens = createMemo(() => {
        const sorted = migratedMemeData
            .slice()
            .sort((a, b) => (b.migrateTime || 0) - (a.migrateTime || 0));

        if (sorted.length > 0) {
            console.log(`[MemePage] 🦋 Newest Token: ${sorted[0].symbol}, Migrated At: ${new Date(sorted[0].migrateTime!).toLocaleTimeString()}`);
        }
        return sorted.slice(0, 9);
    });

    // ✨ 监听新币并在前端语音播报
    const [lastAnnouncedTokenAddr, setLastAnnouncedTokenAddr] = createSignal<string | null>(null);

    createEffect(() => {
        const tokens = recentTokens();
        // 确保有数据
        if (tokens.length > 0) {
            const newest = tokens[0];
            const lastAddr = lastAnnouncedTokenAddr();

            // 如果是页面刚加载 (lastAddr === null)，我们记录它是“当前最新”，但不播报
            // 只有当之后 newest 变了，且不等于 lastAddr 时才播报
            if (lastAddr === null) {
                setLastAnnouncedTokenAddr(newest.contractAddress);
            } else if (lastAddr !== newest.contractAddress) {
                // 发现新币！
                console.log(`[VoiceAlert] 🔔 New Token Detected: ${newest.symbol} (${newest.contractAddress})`);
                speak(`新币发射 ${newest.symbol}`);
                setLastAnnouncedTokenAddr(newest.contractAddress);
            }
        }
    });

    // ✨ 监听键盘事件 'H'
    onMount(() => {
        initializeVoices();
        console.log('[MemePage] 🚀 Dual Column Layout Mounted.');

        const handleKeydown = (e: KeyboardEvent) => {
            // 忽略输入框内的按键
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

            if (e.key.toLowerCase() === 'h') {
                const isShowing = !showKline();
                setShowKline(isShowing);

                // ✨ 如果是开启 K 线，确保已初始化
                if (isShowing) {
                    setChartsInitialized(true);
                }

                console.log('[MemePage] Toggled Kline View:', isShowing, 'Charts Initialized:', chartsInitialized());
            }
        };

        window.addEventListener('keydown', handleKeydown);
        onCleanup(() => window.removeEventListener('keydown', handleKeydown));
    });

    return (
        <div class="meme-board-container">
            <header class="meme-header">
                <div style={{ display: 'flex', "align-items": 'center', gap: '15px' }}>
                    <h1>🐶 Meme Rush <span style={{ "font-size": '0.6em', color: '#999', "font-weight": 'normal' }}>KANBAN</span></h1>
                    <nav class="nav-links" style={{ display: 'flex', gap: '10px' }}>
                        <a href="/" class="nav-btn" style={{ "text-decoration": 'none', color: '#666', "font-size": '0.9rem' }}>🔥 Hotlist</a>
                        <span class="nav-btn active" style={{ "font-weight": 'bold', color: '#007bff', background: '#e7f1ff', padding: '4px 10px', "border-radius": '4px', "font-size": '0.9rem' }}>已发射看板</span>
                    </nav>
                </div>
                <div style={{ display: 'flex', gap: '15px', "align-items": 'center', "font-size": '0.85em', color: '#666' }}>
                    {/* ✨ 提示用户快捷键 */}
                    <div style={{ background: '#eee', padding: '2px 6px', "border-radius": '4px', "font-size": '0.8em' }} title="Press 'H' to toggle charts">
                        按 <b>H</b> 切换 K 线
                    </div>
                    <div>⏱ {lastUpdate()}</div>
                    <div class="status-indicator" title="Migrated Tokens Feed">
                        <span style={{
                            display: 'inline-block', width: '8px', height: '8px', "border-radius": '50%',
                            background: migratedStatus().includes('Connected') ? '#28a745' : '#dc3545',
                            "margin-right": '4px'
                        }}></span>
                        {migratedStatus()}
                    </div>
                </div>
            </header>

            <div class="meme-board-grid">
                {/* 列表 1: Liquidity 排名 */}
                <MemeColumn
                    title="💧 流动性榜 (Top 9 Liq)"
                    items={topLiquidityTokens()}
                    count={topLiquidityTokens().length}
                />

                {/* 列表 2: 最近发射 */}
                <MemeColumn
                    title="🚀 最新发射 (Top 9 New)"
                    items={recentTokens()}
                    count={recentTokens().length}
                />
            </div>
        </div>
    );
};

export default MemePage;
