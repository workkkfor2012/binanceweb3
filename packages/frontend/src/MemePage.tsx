// packages/frontend/src/MemePage.tsx
import { Component, createMemo, For, Show, onMount, createSignal } from 'solid-js';
import { useMarketData } from './hooks/useMarketData';
import type { MarketItem } from 'shared-types';

const BACKEND_URL = 'http://localhost:3001';

// --- 全局类型定义 ---
declare global {
    interface Window {
        twttr: any;
    }
}

// ✨ 工具函数：提取推特 ID
const extractTweetId = (input: string | undefined | null): string | null => {
    if (!input) return null;
    const str = String(input).trim();
    if (/^\d+$/.test(str)) return str;
    const match = str.match(/status\/(\d+)/);
    if (match && match[1]) return match[1];
    return null;
};

// --- 组件：Bonding Curve 进度条 (紧凑版) ---
const BondingCurveProgress: Component<{ percent: number }> = (props) => {
    const colorClass = () => {
        if (props.percent >= 90) return 'bg-success';
        if (props.percent >= 50) return 'bg-warning';
        return 'bg-primary';
    };
    return (
        <div class="progress-container" title={`Bonding Curve: ${props.percent.toFixed(2)}%`} style={{ width: '100%', backgroundColor: '#e9ecef', borderRadius: '3px', height: '12px', overflow: 'hidden', position: 'relative' }}>
            <div 
                class={`progress-fill ${colorClass()}`} 
                style={{ 
                    width: `${props.percent}%`, 
                    height: '100%', 
                    backgroundColor: props.percent >= 90 ? '#28a745' : props.percent >= 50 ? '#ffc107' : '#007bff',
                }}
            ></div>
            <span style={{ fontSize: '9px', color: '#000', position: 'absolute', top: 0, left: '4px', lineHeight: '12px', fontWeight: 'bold' }}>{props.percent.toFixed(1)}%</span>
        </div>
    );
};

// --- 组件：推特嵌入 (固定宽度版) ---
const TweetEmbed: Component<{ tweetId: string; symbol: string }> = (props) => {
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
                        width: 350 // ✨ 核心：强制固定宽度，避免拉伸
                    }
                ).then((el: any) => {
                    if (el) setIsLoaded(true);
                    else if(containerRef) containerRef.innerHTML = `<div style="color:#ccc; font-size:11px;">Tweet removed</div>`;
                });
            } else {
                setTimeout(renderTweet, 100);
            }
        };
        renderTweet();
    });

    return (
        <div 
            class="tweet-embed-wrapper" 
            style={{ 
                "min-height": isLoaded() ? "auto" : "150px",
                "width": "350px", // 容器也固定宽度
                "background": isLoaded() ? "transparent" : "#f8f9fa",
                "border-radius": "8px",
                "display": "flex",
                "justify-content": "center",
                "align-items": "center",
                "flex-shrink": 0 // 防止被 Flexbox 压缩
            }}
        >
            <div ref={containerRef} style={{ width: '100%' }}>
                <span style={{ color: '#aaa', fontSize: '11px' }}>Loading...</span>
            </div>
        </div>
    );
};

// --- 组件：表格行 (核心布局逻辑) ---
const MemeRow: Component<{ item: MarketItem }> = (props) => {
    const { item } = props;
    
    const cleanTwitterId = () => extractTweetId((item as any).twitterId || (item as any).twitter);
    const hasDetails = () => !!item.narrative || !!cleanTwitterId();
    const iconUrl = item.icon ? `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon)}` : '';

    const handleRowClick = (e: MouseEvent) => { 
        // 允许用户复制文字，不触发跳转
        if (window.getSelection()?.toString()) return;
        window.open(`/token.html?address=${item.contractAddress}&chain=${item.chain}`, '_blank'); 
    };

    const formatTime = (ts: number | undefined) => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '-';
    
    // 辅助样式：小字体
    const smallCellStyle = { "font-size": "0.85em", "color": "#555", "vertical-align": "middle" };

    return (
        <>
            {/* --- 第一行：核心指标 (紧凑布局) --- */}
            <tr 
                onClick={handleRowClick} 
                style={{ 
                    cursor: 'pointer', 
                    "background-color": "#fff",
                    "border-bottom": hasDetails() ? "none" : "1px solid #eee",
                    "transition": "background-color 0.1s"
                }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f9fbfd'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#fff'}
            >
                {/* 1. Icon (极简) */}
                <td style={{ padding: "8px 10px", width: "40px" }}>
                    <div style={{ width: '36px', height: '36px' }}>
                        <Show when={item.icon} fallback={<div style={{width:'100%', height:'100%', background:'#eee', borderRadius:'50%'}}></div>}>
                            <img src={iconUrl} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} onError={(e) => e.currentTarget.style.display='none'} />
                        </Show>
                    </div>
                </td>

                {/* 2. Token Name (突出显示) */}
                <td style={{ padding: "8px 10px" }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontWeight: 'bold', fontSize: '1rem', color: '#000' }}>
                                {item.symbol}
                            </span>
                            {/* Twitter 标 */}
                            <Show when={cleanTwitterId()}>
                                <a 
                                    href={`https://twitter.com/i/status/${cleanTwitterId()}`} 
                                    target="_blank" 
                                    onClick={(e) => e.stopPropagation()}
                                    title="Open on Twitter"
                                    style={{ 
                                        "font-size": "10px", 
                                        "background": "#1DA1F2", 
                                        "color": "white", 
                                        "padding": "1px 4px", 
                                        "border-radius": "3px", 
                                        "text-decoration": "none",
                                        "line-height": "1.2"
                                    }}
                                >
                                    𝕏
                                </a>
                            </Show>
                        </div>
                        <Show when={item.name}>
                            <span style={{ fontSize: '0.75em', color: '#888', maxWidth: '200px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {item.name}
                            </span>
                        </Show>
                    </div>
                </td>

                {/* 辅助列：紧凑显示 */}
                <td style={{...smallCellStyle, "font-family": "monospace"}}>{formatTime(item.createTime)}</td>
                <td style={{ padding: "8px 10px", width: "120px", verticalAlign: "middle" }}>
                    <BondingCurveProgress percent={item.progress || 0} />
                </td>
                <td style={smallCellStyle}>${item.marketCap?.toLocaleString() || '-'}</td>
                <td style={smallCellStyle}>{item.holders?.toLocaleString() || '-'}</td>
                <td style={smallCellStyle}>
                    <span style={{ fontWeight: (item.devMigrateCount || 0) > 0 ? 'bold' : 'normal', color: (item.devMigrateCount || 0) > 0 ? '#d63384' : 'inherit' }}>
                        {item.devMigrateCount ?? '-'}
                    </span>
                </td>
                <td style={{...smallCellStyle, "font-family": "monospace", color: "#999"}}>
                    {item.contractAddress.slice(0, 4)}...{item.contractAddress.slice(-4)}
                </td>
            </tr>

            {/* --- 第二行：详情 (左右分栏布局) --- */}
            <Show when={hasDetails()}>
                <tr style={{ "border-bottom": "1px solid #e1e4e8", "background-color": "#fff" }}>
                    <td style={{ border: "none" }}></td> {/* 留空对齐 Icon */}
                    <td colspan={7} style={{ padding: "0 20px 15px 0", border: "none" }}>
                        
                        {/* ✨ 核心布局容器：Flexbox */}
                        <div style={{ 
                            display: "flex", 
                            gap: "20px", 
                            "align-items": "flex-start", // 顶部对齐
                            "flex-wrap": "wrap" // 极窄屏幕自动换行
                        }}>
                            
                            {/* 左侧：Narrative (占据剩余空间) */}
                            <Show when={item.narrative}>
                                <div style={{ 
                                    flex: "1", 
                                    "min-width": "300px", // 最小宽度
                                    "background-color": "#f8f9fa",
                                    "padding": "12px 16px",
                                    "border-radius": "6px",
                                    "border": "1px solid #eee",
                                    "box-shadow": "inset 0 1px 2px rgba(0,0,0,0.02)"
                                }}>
                                    <div style={{ "font-size": "0.75em", "font-weight": "bold", "color": "#888", "margin-bottom": "6px", "text-transform": "uppercase", "letter-spacing": "0.5px" }}>
                                        Narrative / Story
                                    </div>
                                    <div style={{ 
                                        "font-size": "0.95em", 
                                        color: "#222", 
                                        "line-height": "1.6",
                                        "white-space": "pre-wrap",
                                        "font-family": "-apple-system, system-ui, sans-serif"
                                    }}>
                                        {item.narrative}
                                    </div>
                                </div>
                            </Show>

                            {/* 右侧：Twitter (固定宽度) */}
                            <Show when={cleanTwitterId()}>
                                <div style={{ flex: "0 0 auto" }}> {/* 不伸缩，保持本身大小 */}
                                    <TweetEmbed tweetId={cleanTwitterId()!} symbol={item.symbol} />
                                </div>
                            </Show>

                        </div>
                    </td>
                </tr>
            </Show>
        </>
    );
};

// --- 主页面 ---
const MemePage: Component = () => {
    const { marketData, connectionStatus, lastUpdate } = useMarketData('meme_new');

    const memeList = createMemo(() => {
        return marketData
            .slice()
            .sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
    });

    onMount(() => console.log('[MemePage] 🚀 Mounted.'));

    return (
        <div class="page-wrapper" style={{ padding: '20px', "background-color": "#f4f7f9", "min-height": "100vh" }}>
            {/* Header */}
            <header class="app-header" style={{ marginBottom: '15px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', padding: '15px 20px', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
                <div class="header-left">
                    <h1 style={{ margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
                        🐶 Meme Rush 
                        <span class="subtitle" style={{ fontSize: '0.4em', color: '#999', fontWeight: 'normal', marginTop: '5px' }}>REALTIME SCANNER</span>
                    </h1>
                </div>
                
                <div class="stats-panel" style={{ textAlign: 'right', display: 'flex', gap: '20px', alignItems: 'center', fontSize: '0.85em', color: '#666' }}>
                    <nav class="nav-links" style={{ display: 'flex', gap: '10px', marginRight: '20px' }}>
                        <a href="/" class="nav-btn" style={{ textDecoration: 'none', color: '#666', padding: '4px 8px' }}>🔥 Hotlist</a>
                        <span class="nav-btn active" style={{ fontWeight: 'bold', textDecoration: 'none', color: '#007bff', background: '#e7f1ff', padding: '4px 12px', borderRadius: '12px' }}>🐶 Meme New</span>
                    </nav>
                    <div>
                        <span class={`dot ${connectionStatus().includes('Connected') ? 'green' : 'red'}`} style={{display:'inline-block', width:'8px', height:'8px', borderRadius:'50%', background: connectionStatus().includes('Connected')?'#28a745':'#dc3545', marginRight:'5px'}}></span>
                        {connectionStatus()}
                    </div>
                    <div>Wait: {memeList().length}</div>
                </div>
            </header>

            {/* Table */}
            <div class="table-container meme-table-container" style={{ background: '#fff', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}> {/* ✨ table-layout: fixed 很重要 */}
                    <thead style={{ backgroundColor: '#f8f9fa', color: '#666', fontSize: '0.85em', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        <tr>
                            <th style={{ width: '60px', padding: '12px 10px' }}>Icon</th>
                            <th style={{ width: 'auto', padding: '12px 10px' }}>Token</th> {/* 自动宽度，占据剩余空间 */}
                            <th style={{ width: '90px', padding: '12px 10px' }}>Created</th>
                            <th style={{ width: '140px', padding: '12px 10px' }}>Bonding</th>
                            <th style={{ width: '90px', padding: '12px 10px' }}>MCap</th>
                            <th style={{ width: '70px', padding: '12px 10px' }}>Holders</th>
                            <th style={{ width: '70px', padding: '12px 10px' }}>Dev</th>
                            <th style={{ width: '90px', padding: '12px 10px' }}>Addr</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={memeList()} fallback={
                            <tr><td colspan={8} class="empty-state" style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
                                📡 Waiting for new meme tokens...
                            </td></tr>
                        }>
                            {(item) => <MemeRow item={item} />}
                        </For>
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default MemePage;