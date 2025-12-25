// packages/frontend/src/SingleTokenView.tsx
import { Component } from 'solid-js';
import type { MarketItem } from './types.js';
import SingleKlineChart from "./SingleKlineChart.jsx";
import { ChartTheme } from "./themes.js";
import { MARKET_BACKEND_URL } from './socket.js';
import './css/single-token-view.css';

interface SingleTokenViewProps {
    token: MarketItem;
    activeTimeframe: string;
    theme: ChartTheme;
}

const formatTimeframeLabel = (timeframe: string): string => {
    return timeframe.replace('m', ' Minute').replace('h', ' Hour').replace('d', ' Day').toUpperCase();
}

const SingleTokenView: Component<SingleTokenViewProps> = (props) => {
    return (
        <div
            class="single-token-view-container"
            style={{ "background-color": props.theme.grid.vertLines }}
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
                    <img
                        src={`${MARKET_BACKEND_URL}/image-proxy?url=${encodeURIComponent(props.token.icon!)}&symbol=${props.token.symbol}`}
                        class="icon"
                        alt={props.token.symbol}
                        onError={(e) => {
                            e.currentTarget.style.display = 'none';
                        }}
                    />
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
                    "background-color": props.theme.grid.vertLines,
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
                        theme={props.theme}
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
                        theme={props.theme}
                    />
                </div>
            </div>
        </div>
    );
};

export default SingleTokenView;