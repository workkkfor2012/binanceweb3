// packages/frontend/src/SingleTokenView.tsx
import { Component } from 'solid-js';
import type { MarketItem } from 'shared-types';
import SingleKlineChart from './SingleKlineChart';
import './css/single-token-view.css';

interface SingleTokenViewProps {
    token: MarketItem;
    activeTimeframe: string; 
}

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
                        viewportState={null}
                        activeChartId={null}
                        showAxes={true} // ✨ 在这里启用坐标轴
                    />
                </div>
                <div class="chart-pane">
                    <div class="timeframe-label">{formatTimeframeLabel(props.activeTimeframe)} CHART</div>
                    <SingleKlineChart 
                        tokenInfo={props.token} 
                        timeframe={props.activeTimeframe}
                        viewportState={null}
                        activeChartId={null}
                        showAxes={true} // ✨ 也在这里启用坐标轴
                    />
                </div>
            </div>
        </div>
    );
};

export default SingleTokenView;