// packages/frontend/src/MemePage.tsx
import { Component, createMemo, For, Show, onMount, createSignal } from 'solid-js';
import { useMarketData } from './hooks/useMarketData';
import type { MemeItem } from './types';


const BACKEND_URL = 'http://localhost:3001';

declare global {
    interface Window {
        twttr: any;
    }
}

interface MemeCardProps {
    item: MemeItem;
}

interface ColumnProps {
    title: string;
    items: MemeItem[];
    count: number;
}

// ID 提取 (支持 x.com 和 twitter.com)
const extractTweetId = (input: string | undefined | null): string | null => {
    if (!input) return null;
    const str = String(input).trim();
    if (/^\d+$/.test(str)) return str;
    const match = str.match(/status\/(\d+)/);
    if (match && match[1]) return match[1];
    return null;
};

const formatTime = (ts: number | undefined) => {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

// --- 推特组件 ---
const TweetEmbed: Component<{ tweetId: string; }> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    const [isLoaded, setIsLoaded] = createSignal(false);

    onMount(() => {
        if (!props.tweetId) return;
        console.log(`[TweetEmbed] Mounting for ID: ${props.tweetId}`);

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
                        // ✨ 修改: 宽度设为 auto 以适应 Grid 布局的卡片宽度
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
            <div ref={containerRef} style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
                <span style={{ color: '#aaa', fontSize: '11px' }}>Loading Tweet...</span>
            </div>
        </div>
    );

};

// --- 卡片组件 ---
const MemeCard: Component<MemeCardProps> = (props) => {
    const { item } = props;
    const cleanTwitterId = createMemo(() => extractTweetId(item.twitterId || item.twitter));
    const iconUrl = item.icon ? `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon)}` : '';

    const handleCardClick = () => {
        window.open(`/token.html?address=${item.contractAddress}&chain=${item.chain}`, '_blank');
    };

    const handleContentClick = (e: MouseEvent) => e.stopPropagation();

    const formattedCap = () => {
        if (!item.marketCap) return '-';
        if (item.marketCap >= 1000000) return (item.marketCap / 1000000).toFixed(1) + 'M';
        if (item.marketCap >= 1000) return (item.marketCap / 1000).toFixed(1) + 'K';
        return item.marketCap.toString();
    };

    const getStatusColor = (status: string | undefined) => {
        if (!status) return '#6c757d';
        if (status === 'dex') return '#28a745';
        if (status === 'bonding_curve') return '#007bff';
        return '#6c757d';
    };

    return (
        <div class="meme-card" onClick={handleCardClick}>
            {/* Header */}
            <div class="card-header-layout">
                <Show when={item.icon} fallback={<div style={{ width: '42px', height: '42px', background: '#eee', borderRadius: '50%' }}></div>}>
                    <img src={iconUrl} class="card-icon" loading="lazy" onError={(e) => e.currentTarget.style.display = 'none'} />
                </Show>

                <div class="card-info-col">
                    <div class="info-row-top">
                        <span class="card-symbol" title={item.symbol}>{item.symbol}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                            <Show when={item.status}>
                                <span style={{ fontSize: '0.6em', background: getStatusColor(item.status), color: '#fff', padding: '1px 4px', borderRadius: '3px' }}>
                                    {item.status?.toUpperCase()}
                                </span>
                            </Show>
                            <span class="card-time">{formatTime(item.createTime || Date.now())}</span>
                        </div>
                    </div>

                    <div class="info-row-bottom">
                        <span class="stat-badge badge-cap">${formattedCap()}</span>
                        <span class="stat-badge">👥 {item.holders || '-'}</span>
                        <Show when={(item.devMigrateCount || 0) > 0}>
                            <span class="stat-badge badge-dev">Dev:{item.devMigrateCount}</span>
                        </Show>
                    </div>
                </div>
            </div>

            {/* Narrative */}
            <Show when={item.narrative}>
                <div class="card-narrative-box" onClick={handleContentClick}>
                    {item.narrative}
                </div>
            </Show>

            {/* Tweet */}
            <Show when={cleanTwitterId()}>
                <div onClick={handleContentClick} style={{ width: '100%', overflow: 'hidden' }}>
                    <TweetEmbed tweetId={cleanTwitterId()!} />
                </div>
            </Show>

            {/* Bonding Curve */}
            <div class="card-bonding-line" title={`Bonding Curve: ${item.progress?.toFixed(1)}%`}>
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

// --- Column ---
const MemeColumn: Component<ColumnProps> = (props) => {
    return (
        <div class="meme-column">
            <div class="column-header">
                <span>{props.title}</span>
                <span class="column-badge" style={{ background: '#dce4ea', padding: '2px 8px', borderRadius: '10px', fontSize: '0.85em' }}>
                    {props.count}
                </span>
            </div>
            <div class="column-content">
                <For each={props.items}>
                    {(item) => <MemeCard item={item} />}
                </For>
                <Show when={props.items.length === 0}>
                    <div style={{ textAlign: 'center', padding: '50px 0', color: '#999', fontSize: '0.9em', gridColumn: '1 / -1' }}>
                        Waiting for data...
                    </div>
                </Show>
            </div>
        </div>
    );
};

// --- Page ---
const MemePage: Component = () => {
    // ✨ 修改 1: 仅获取 "已发射/金狗" 数据
    const {
        marketData: migratedMemeData,
        connectionStatus: migratedStatus,
        lastUpdate
    } = useMarketData<MemeItem>('meme_migrated');

    // 处理已发射 (按创建时间倒序)
    const migratedTokens = createMemo(() => {
        const sorted = migratedMemeData
            .slice()
            .sort((a, b) => (b.createTime || 0) - (a.createTime || 0));

        if (sorted.length > 0) {
            console.log(`[MemePage] 🦋 MigratedTokens Sorted (Top 1): ${sorted[0].symbol}, Time: ${new Date(sorted[0].createTime).toLocaleTimeString()}`);
        }
        return sorted;
    });

    onMount(() => console.log('[MemePage] 🚀 Migrated-Only Layout Mounted.'));

    return (
        <div class="meme-board-container">
            <header class="meme-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                    <h1>🐶 Meme Rush <span style={{ fontSize: '0.6em', color: '#999', fontWeight: 'normal' }}>KANBAN</span></h1>
                    <nav class="nav-links" style={{ display: 'flex', gap: '10px' }}>
                        <a href="/" class="nav-btn" style={{ textDecoration: 'none', color: '#666', fontSize: '0.9rem' }}>🔥 Hotlist</a>
                        <span class="nav-btn active" style={{ fontWeight: 'bold', color: '#007bff', background: '#e7f1ff', padding: '4px 10px', borderRadius: '4px', fontSize: '0.9rem' }}>已发射看板</span>
                    </nav>
                </div>
                <div style={{ display: 'flex', gap: '15px', alignItems: 'center', fontSize: '0.85em', color: '#666' }}>
                    <div>⏱ {lastUpdate()}</div>
                    <div class="status-indicator" title="Migrated Tokens Feed">
                        <span style={{
                            display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
                            background: migratedStatus().includes('Connected') ? '#28a745' : '#dc3545',
                            marginRight: '4px'
                        }}></span>
                        {migratedStatus()}
                    </div>
                </div>
            </header>

            <div class="meme-board-grid">
                {/* ✨ 修改 2: 仅渲染这一列 */}
                <MemeColumn title="🦋 已发射/金狗 (Migrated)" items={migratedTokens()} count={migratedTokens().length} />
            </div>
        </div>
    );

};

export default MemePage;