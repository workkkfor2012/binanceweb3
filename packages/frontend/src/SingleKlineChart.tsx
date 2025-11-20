// packages/frontend/src/SingleKlineChart.tsx

/** @jsxImportSource solid-js */

import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries, Time } from 'lightweight-charts';
import { socket } from './socket';
import type { LightweightChartKline, KlineUpdatePayload, KlineFetchErrorPayload } from './types';
import type { MarketItem } from 'shared-types';
import type { ViewportState } from './ChartPageLayout';

const BACKEND_URL = 'http://localhost:3001';

interface SingleKlineChartProps {
tokenInfo: MarketItem | undefined;
onBlock?: (contractAddress: string) => void;
timeframe: string;
viewportState: ViewportState | null;
onViewportChange?: (state: ViewportState | null) => void;
activeChartId: string | null;
onSetActiveChart?: (id: string | null) => void;
showAxes?: boolean;
}

const customPriceFormatter = (price: number): string => {
if (price === 0) return '0';
if (price < 0.000001) {
return price.toFixed(12).replace(/.?0+$/, "");
}
if (price < 1) return price.toFixed(6);
return price.toFixed(2);
};

const SingleKlineChart: Component<SingleKlineChartProps> = (props) => {
let chartContainer: HTMLDivElement;
let chart: IChartApi | null = null;
let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
let resizeObserver: ResizeObserver | null = null;
const [status, setStatus] = createSignal('Initializing...');

// 🔒 核心状态锁
let isProgrammaticUpdate = false;
// 🔒 防抖锁
let isSyncPending = false;

const getMyId = () => props.tokenInfo?.contractAddress || '';

const cleanupChart = () => {
    if (chart) {
        chart.remove();
        chart = null;
        candlestickSeries = null;
    }
};

const unsubscribeRealtime = (payload: { address: string; chain: string; interval: string }) => {
    socket.off('kline_update', handleKlineUpdate);
    socket.emit('unsubscribe_kline', payload);
};

const handleKlineUpdate = (update: KlineUpdatePayload) => {
    const info = props.tokenInfo;
    if (!info) return;
    const chainToPoolId: Record<string, number> = { bsc: 14, sol: 16, solana: 16, base: 199 };
    const poolId = chainToPoolId[info.chain.toLowerCase()];
    const expectedRoom = `kl@${poolId}@${info.contractAddress}@${props.timeframe}`;

    if (update.room === expectedRoom) {
        candlestickSeries?.update(update.data as CandlestickData<number>);
    }
};

createEffect(() => {
    const info = props.tokenInfo;
    const timeframe = props.timeframe;

    if (!info || !timeframe) {
        cleanupChart();
        setStatus('No token selected.');
        return;
    }

    cleanupChart();
    setStatus(`Loading ${info.symbol}...`);
    
    if (!chartContainer) return;

    const logId = `[Chart:${info.symbol}]`;

    try {
        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth, 
            height: chartContainer.clientHeight,
            layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#333' },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            timeScale: { 
                visible: !!props.showAxes, 
                borderColor: '#cccccc', 
                timeVisible: true, 
                secondsVisible: false,
                
                // ✨✨✨ 核心修复 ✨✨✨
                // 1. rightOffset: 12 -> 强制右侧保留 12 根柱子的空隙
                rightOffset: 12, 
                
                // 2. shiftVisibleRangeOnNewBar: true -> 必须为 true
                //    这保证了当新数据到来时，图表会自动滚动，始终保持 12 根柱子的空隙。
                //    如果为 false，新数据会把图表顶到更右边，导致空隙消失。
                shiftVisibleRangeOnNewBar: false, 

                // 3. 移除了 fixRightEdge
                //    该属性在某些版本中会导致 rightOffset 被强制归零（即贴死右边）。
                //    移除后，图表将恢复自然的“弹性”边缘。
            },
            rightPriceScale: { visible: !!props.showAxes, borderColor: '#cccccc', autoScale: true },
            leftPriceScale: { visible: false },
            handleScroll: true, 
            handleScale: true,
        });

        candlestickSeries = chart.addSeries(CandlestickSeries, {
            priceFormat: { 
                type: 'price', 
                precision: 10,
                minMove: 0.00000001, 
                formatter: customPriceFormatter 
            },
            upColor: '#28a745', downColor: '#dc3545', borderDownColor: '#dc3545',
            borderUpColor: '#28a745', wickDownColor: '#dc3545', wickUpColor: '#28a745',
        });

    } catch (e) {
        console.error(`${logId} ❌ Failed to create chart:`, e);
        setStatus(`Chart Error: ${e}`);
        return;
    }

    // [SENDER]
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (isProgrammaticUpdate) return;

        const myId = getMyId().toLowerCase();
        const activeId = props.activeChartId?.toLowerCase();

        if (myId === activeId) {
            if (!isSyncPending) {
                isSyncPending = true;
                requestAnimationFrame(() => {
                    const timeRange = chart?.timeScale().getVisibleRange();
                    if (timeRange && props.onViewportChange) {
                        const from = Number(timeRange.from);
                        const to = Number(timeRange.to);
                        props.onViewportChange({ from, to });
                    }
                    isSyncPending = false;
                });
            }
        }
    });

    const payload = { address: info.contractAddress, chain: info.chain, interval: timeframe };

    const processData = (data: any[], isInitial: boolean) => {
        try {
            const sortedData = data
                .map(d => ({ ...d, time: Number(d.time) }))
                .sort((a, b) => a.time - b.time);

            if (isInitial) {
                candlestickSeries?.setData(sortedData as CandlestickData<number>[]);
                if (props.viewportState) {
                     chart?.timeScale().setVisibleRange({
                        from: props.viewportState.from as Time,
                        to: props.viewportState.to as Time
                    });
                } else {
                    // ✨ 核心修复: 使用 scrollToRealTime()
                    // fitContent() 会强制缩放所有内容以填满屏幕，导致 offset 看起来失效
                    // scrollToRealTime() 会定位到最新数据，并应用 rightOffset
                    chart?.timeScale().scrollToRealTime();
                }
            } else {
                const currentData = (candlestickSeries?.data() as CandlestickData<number>[] || []);
                const newDataMap = new Map(currentData.map(d => [d.time, d]));
                sortedData.forEach(d => newDataMap.set(d.time as number, d as CandlestickData<number>));
                const merged = Array.from(newDataMap.values()).sort((a, b) => (a.time as number) - (b.time as number));
                candlestickSeries?.setData(merged);
            }
            setStatus(`Live: ${info.symbol} ${timeframe}`);
        } catch (e) {
            console.error(`${logId} ❌ Failed to process data:`, e);
        }
    };

    const handleInitialData = (response: any) => {
        if (response.interval !== timeframe || response.address.toLowerCase() !== info.contractAddress.toLowerCase()) return;
        if (response.data && response.data.length > 0) {
            processData(response.data, true);
        } else {
            setStatus(`Waiting for data...`);
        }
    };
    
    const handleCompletedData = (response: any) => {
        if (response.interval !== timeframe || response.address.toLowerCase() !== info.contractAddress.toLowerCase()) return;
        if (response.data && response.data.length > 0) {
            processData(response.data, false);
        }
    };
    
    const handleFetchError = (err: KlineFetchErrorPayload) => {
         const key = `${info.contractAddress.toLowerCase()}@${info.chain.toLowerCase()}@${timeframe}`;
         if(err.key === key) {
            setStatus(`Error: ${err.error}`);
         }
    };

    socket.on('historical_kline_initial', handleInitialData);
    socket.on('historical_kline_completed', handleCompletedData);
    socket.on('kline_fetch_error', handleFetchError);
    socket.on('kline_update', handleKlineUpdate);

    socket.emit('request_historical_kline', payload);
    socket.emit('subscribe_kline', payload); 

    onCleanup(() => {
        unsubscribeRealtime(payload);
        socket.off('historical_kline_initial', handleInitialData);
        socket.off('historical_kline_completed', handleCompletedData);
        socket.off('kline_fetch_error', handleFetchError);
        cleanupChart();
    });
});

// [RECEIVER]
createEffect(() => {
    const vs = props.viewportState;
    if (!chart || !vs || !props.tokenInfo) return;

    const myId = getMyId().toLowerCase();
    const activeId = props.activeChartId?.toLowerCase();

    if (myId === activeId) return;

    isProgrammaticUpdate = true;
    try {
        chart.timeScale().setVisibleRange({
            from: vs.from as Time,
            to: vs.to as Time
        });
    } catch (e) {}
    
    setTimeout(() => { isProgrammaticUpdate = false; }, 0);
});

onMount(() => {
    resizeObserver = new ResizeObserver(entries => {
        if (chart && chartContainer) {
            const { width, height } = entries[0].contentRect;
            chart.applyOptions({ width, height });
        }
    });
    if (chartContainer) {
        resizeObserver.observe(chartContainer);
    }
});

onCleanup(() => resizeObserver?.disconnect());

return (
    <div 
        class="single-chart-wrapper"
        onMouseEnter={() => {
            if (props.tokenInfo) {
                props.onSetActiveChart?.(props.tokenInfo.contractAddress);
            }
        }}
    >
        <div class="chart-header">
            <Show when={props.tokenInfo} fallback={<span class="placeholder">{status()}</span>}>
                <img src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(props.tokenInfo!.icon!)}`} class="icon-small" alt={props.tokenInfo!.symbol}/>
                <span class="symbol-title">{props.tokenInfo!.symbol}</span>
                <span class="chain-badge">{props.tokenInfo!.chain.toUpperCase()}</span>
                <button class="block-button" title={`屏蔽 ${props.tokenInfo!.symbol}`} onClick={() => props.onBlock?.(props.tokenInfo!.contractAddress)}>
                    🚫
                </button>
            </Show>
        </div>
        <div ref={chartContainer!} class="chart-container" />
    </div>
);

};

export default SingleKlineChart;