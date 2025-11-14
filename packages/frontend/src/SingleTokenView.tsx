// packages/frontend/src/SingleTokenView.tsx
import { Component } from 'solid-js';
import type { MarketItem } from 'shared-types';
import SingleKlineChart from './SingleKlineChart';
import './css/single-token-view.css';

interface SingleTokenViewProps {
    token: MarketItem;
    // 接收由快捷键控制的动态时间周期
    activeTimeframe: string; 
}

// 辅助函数，用于将 '1m', '5m' 等转换为更易读的标签
const formatTimeframeLabel = (timeframe: string): string => {
    return timeframe.replace('m', ' Minute').replace('h', ' Hour').replace('d', ' Day').toUpperCase();
}

const SingleTokenView: Component<SingleTokenViewProps> = (props) => {
    return (
        <div class="single-token-view-container">
            <div class="view-header">
                <div class="token-info">
                    <img src={`http://localhost:3001/image-proxy?url=${encodeURIComponent(props.token.icon!)}`} class="icon" alt={props.token.symbol}/>
                    <h1>{props.token.symbol}</h1>
                    <span class="chain-badge">{props.token.chain.toUpperCase()}</span>
                </div>
                <div class="exit-hint">
                    Press 'F' to return to grid view
                </div>
            </div>
            <div class="chart-panes">
                <div class="chart-pane">
                    <div class="timeframe-label">4 HOUR CHART</div>
                    <SingleKlineChart 
                        tokenInfo={props.token} 
                        timeframe="4h"
                        // 在单视图模式下，这些交互由父组件或此视图本身管理，因此传入 null
                        viewportState={null}
                        activeChartId={null}
                    />
                </div>
                <div class="chart-pane">
                    {/* 标签会根据快捷键动态变化 */}
                    <div class="timeframe-label">{formatTimeframeLabel(props.activeTimeframe)} CHART</div>
                    <SingleKlineChart 
                        tokenInfo={props.token} 
                        timeframe={props.activeTimeframe}
                        viewportState={null}
                        activeChartId={null}
                    />
                </div>
            </div>
        </div>
    );
};

export default SingleTokenView;