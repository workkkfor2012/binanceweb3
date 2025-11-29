// packages/frontend/src/MemePage.tsx
import { Component, createMemo, For, Show, createSignal, createEffect } from 'solid-js';
import { useMarketData } from './hooks/useMarketData';
import type { MarketItem } from 'shared-types';

const BACKEND_URL = 'http://localhost:3001';

// --- 组件：Bonding Curve 进度条 ---
const BondingCurveProgress: Component<{ percent: number }> = (props) => {
    const colorClass = () => {
        if (props.percent >= 90) return 'bg-success'; // 绿色
        if (props.percent >= 50) return 'bg-warning'; // 黄色
        return 'bg-primary'; // 蓝色
    };
    return (
        <div class="progress-container" title={`Bonding Curve: ${props.percent.toFixed(2)}%`} style={{ width: '100%', backgroundColor: '#eee', borderRadius: '4px', height: '16px', overflow: 'hidden', position: 'relative' }}>
            <div 
                class={`progress-fill ${colorClass()}`} 
                style={{ 
                    width: `${props.percent}%`, 
                    height: '100%', 
                    backgroundColor: props.percent >= 90 ? '#28a745' : props.percent >= 50 ? '#ffc107' : '#007bff',
                    transition: 'width 0.3s ease'
                }}
            ></div>
            <span style={{ fontSize: '10px', color: '#000', position: 'absolute', top: 0, left: '5px', lineHeight: '16px' }}>{props.percent.toFixed(1)}%</span>
        </div>
    );
};

// --- 组件：表格行 ---
const MemeRow: Component<{ item: MarketItem }> = (props) => {
    const { item } = props;
    const [isExpanded, setIsExpanded] = createSignal(false);
    const iconUrl = item.icon ? `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(item.icon)}` : '';
    
    // 点击跳转到详情页
    const handleRowClick = (e: MouseEvent) => { 
        // 如果点击的是 expand 按钮，不要跳转
        if ((e.target as HTMLElement).closest('.expand-btn')) return;
        window.open(`/token.html?address=${item.contractAddress}&chain=${item.chain}`, '_blank'); 
    };
    
    const formatTime = (ts: number | undefined) => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '-';

    // ✨ 调试日志：如果此行有 narrative，打印出来方便调试
    createEffect(() => {
        if (item.narrative) {
            // console.log(`[Frontend] Narrative received for ${item.symbol}:`, item.narrative);
        }
    });

    return (
        <>
            <tr onClick={handleRowClick} class="meme-row" style={{ cursor: 'pointer', "border-bottom": isExpanded() ? "none" : "1px solid #eee" }}>
                <td>
                    <div class="meme-icon-wrapper" style={{ width: '40px', height: '40px' }}>
                        <Show when={item.icon} fallback={<div class="icon-placeholder" style={{width: '100%', height:'100%', background:'#ddd', borderRadius:'50%', textAlign:'center', lineHeight:'40px'}}>?</div>}>
                            <img src={iconUrl} class="icon" style={{ width: '100%', height: '100%', borderRadius: '50%' }} onError={(e) => e.currentTarget.style.display='none'} />
                        </Show>
                    </div>
                </td>
                <td>
                    <div class="meme-name-group" style={{ display: 'flex', flexDirection: 'column' }}>
                        <span class="symbol" style={{ fontWeight: 'bold' }}>{item.symbol}</span>
                        <Show when={item.name}><span class="fullname" style={{ fontSize: '0.8em', color: '#666' }}>{item.name}</span></Show>
                    </div>
                    {/* ✨ 如果有 narrative，显示一个小标记或按钮 */}
                    <Show when={item.narrative}>
                        <div style={{ "margin-top": "4px" }}>
                            <span 
                                class="expand-btn"
                                onClick={() => setIsExpanded(!isExpanded())}
                                style={{ 
                                    "font-size": "0.75em", 
                                    color: "#007bff", 
                                    "background": "#e7f1ff", 
                                    padding: "2px 6px", 
                                    "border-radius": "4px",
                                    cursor: "pointer",
                                    display: "inline-block"
                                }}
                            >
                                {isExpanded() ? "收起介绍 ⬆" : "查看介绍 ⬇"}
                            </span>
                        </div>
                    </Show>
                </td>
                <td class="time-cell">{formatTime(item.createTime)}</td>
                <td style={{ verticalAlign: 'middle' }}>
                    <BondingCurveProgress percent={item.progress || 0} />
                </td>
                <td>${item.marketCap?.toLocaleString() || '-'}</td>
                <td>{item.holders?.toLocaleString() || '-'}</td>
                <td>
                    {/* 开发者迁移/持仓数量，高亮显示如果有 */}
                    <span style={{ fontWeight: (item.devMigrateCount || 0) > 0 ? 'bold' : 'normal', color: (item.devMigrateCount || 0) > 0 ? 'red' : 'inherit' }}>
                        {item.devMigrateCount ?? '-'}
                    </span>
                </td>
                <td class="address-cell" style={{ fontFamily: 'monospace' }}>
                    {item.contractAddress.substring(0, 4)}...{item.contractAddress.slice(-4)}
                </td>
            </tr>
            {/* ✨ 展开显示 Narrative */}
            <Show when={isExpanded() && item.narrative}>
                <tr style={{ "background-color": "#f8f9fa", "border-bottom": "1px solid #eee" }}>
                    <td colspan={8} style={{ padding: "10px 20px" }}>
                        <div style={{ 
                            "font-size": "0.9em", 
                            color: "#444", 
                            "line-height": "1.5",
                            "white-space": "pre-wrap"
                        }}>
                            <strong>📖 Project Narrative:</strong><br/>
                            {item.narrative}
                        </div>
                    </td>
                </tr>
            </Show>
        </>
    );
};

// --- 主页面 ---
const MemePage: Component = () => {
    // ✨ 核心：这里只订阅 'meme_new'，数据源绝对纯净
    const { marketData, connectionStatus, lastUpdate } = useMarketData('meme_new');

    const memeList = createMemo(() => {
        // 不需要过滤 source，因为房间已经隔离了
        // 只需按时间倒序
        return marketData
            .slice()
            .sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
    });

    return (
        <div class="page-wrapper" style={{ padding: '20px' }}>
            <header class="app-header" style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between' }}>
                <div class="header-left">
                    <h1>🐶 Meme Rush <span class="subtitle" style={{ fontSize: '0.5em', color: '#888' }}>Realtime Scanner</span></h1>
                    {/* 简单的导航链接，方便从这里切回 Hotlist */}
                    <nav class="nav-links" style={{ display: 'flex', gap: '15px' }}>
                        <a href="/" class="nav-btn" style={{ textDecoration: 'none', color: '#666' }}>🔥 Hotlist</a>
                        <span class="nav-btn active" style={{ fontWeight: 'bold', textDecoration: 'underline' }}>🐶 Meme New</span>
                    </nav>
                </div>
                
                <div class="stats-panel" style={{ textAlign: 'right' }}>
                    <div class="status-indicator">
                        <span class={`dot ${connectionStatus().includes('Connected') ? 'green' : 'red'}`}></span>
                        {' '}{connectionStatus()}
                    </div>
                    <div class="update-time">Upd: {lastUpdate()}</div>
                    <div class="count-badge">Total Scanned: {memeList().length}</div>
                </div>
            </header>

            <div class="table-container meme-table-container">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead style={{ backgroundColor: '#f8f9fa' }}>
                        <tr>
                            <th width="50" style={{ padding: '10px' }}>Icon</th>
                            <th>Token / Narrative</th>
                            <th>Created</th>
                            <th width="200">Bonding Curve</th>
                            <th>MCap</th>
                            <th>Holders</th>
                            <th>Dev Coins</th>
                            <th>Address</th>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={memeList()} fallback={
                            <tr><td colspan={8} class="empty-state" style={{ textAlign: 'center', padding: '30px' }}>
                                📡 Waiting for new meme tokens... <br/>
                                <small>(Check backend connection if this persists)</small>
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