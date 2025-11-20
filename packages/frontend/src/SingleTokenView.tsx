// packages/frontend/src/SingleTokenView.tsx
import { Component } from 'solid-js';
import type { MarketItem } from 'shared-types';
import SingleKlineChart from './SingleKlineChart';
import type { ChartTheme } from './themes';
import './css/single-token-view.css';

interface SingleTokenViewProps {
    token: MarketItem;
    activeTimeframe: string; 
    theme: ChartTheme; // ✨ Receive Theme
}

const formatTimeframeLabel = (timeframe: string): string => {
    return timeframe.replace('m', ' Minute').replace('h', ' Hour').replace('d', ' Day').toUpperCase();
}

const SingleTokenView: Component<SingleTokenViewProps> = (props) => {
    return (
        <div 
            class="single-token-view-container"
            style={{ "background-color": props.theme.grid.vertLines }} // 使用稍微深一点的网格颜色作为背景缝隙
        >
            <div 
                class="view-header"
                style={{
                    "background-color": props.theme.layout.background,
                    "color": props.theme.layout.textColor,
                    "border-bottom-color": props.theme.grid.horzLines
                }}
            >
                <div class="token-info">
                    <img src={`http://localhost:3001/image-proxy?url=${encodeURIComponent(props.token.icon!)}`} class="icon" alt={props.token.symbol}/>
                    <h1>{props.token.symbol}</h1>
                    <span class="chain-badge">{props.token.chain.toUpperCase()}</span>
                </div>
                <div class="exit-hint" style={{ opacity: 0.7 }}>
                    Press 'F' to return to grid view
                </div>
            </div>
            <div 
                class="chart-panes"
                style={{ 
                    "background-color": props.theme.grid.vertLines, // 分割线颜色
                    gap: "1px"
                }}
            >
                <div class="chart-pane">
                    <div class="timeframe-label" style={{ color: "#333" }}>4 HOUR CHART</div>
                    <SingleKlineChart 
                        tokenInfo={props.token} 
                        timeframe="4h"
                        viewportState={null}
                        activeChartId={null}
                        showAxes={true}
                        theme={props.theme} // ✨ Pass
                    />
                </div>
                <div class="chart-pane">
                    <div class="timeframe-label" style={{ color: "#333" }}>{formatTimeframeLabel(props.activeTimeframe)} CHART</div>
                    <SingleKlineChart 
                        tokenInfo={props.token} 
                        timeframe={props.activeTimeframe}
                        viewportState={null}
                        activeChartId={null}
                        showAxes={true}
                        theme={props.theme} // ✨ Pass
                    />
                </div>
            </div>
        </div>
    );
};

export default SingleTokenView;