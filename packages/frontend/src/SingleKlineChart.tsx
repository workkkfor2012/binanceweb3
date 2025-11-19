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

// 🔒 核心并发控制：标记是否正在进行程序化缩放，防止 ViewportState 循环死锁
let isProgrammaticUpdate = false;

const getLogId = () => `[${props.tokenInfo?.symbol || '???'} @ ${props.timeframe}]`;

// 清理旧图表资源
const cleanupChart = () => {
    if (chart) {
        chart.remove();
        chart = null;
        candlestickSeries = null;
    }
};

// 取消 Socket 订阅
const unsubscribeRealtime = (payload: { address: string; chain: string; interval: string }) => {
    socket.off('kline_update', handleKlineUpdate);
    socket.emit('unsubscribe_kline', payload);
};

// 处理 Socket 实时推送
const handleKlineUpdate = (update: KlineUpdatePayload) => {
    const info = props.tokenInfo;
    if (!info) return;
    // 简单的链ID映射
    const chainToPoolId: Record<string, number> = { bsc: 14, sol: 16, solana: 16, base: 199 };
    const poolId = chainToPoolId[info.chain.toLowerCase()];
    const expectedRoom = `kl@${poolId}@${info.contractAddress}@${props.timeframe}`;

    if (update.room === expectedRoom) {
        candlestickSeries?.update(update.data as CandlestickData<number>);
    }
};

// 核心 Effect：当 Token 或 Timeframe 变化时，重建图表
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

    const logId = `[${info.symbol} @ ${timeframe}]`;

    try {
        // 创建图表实例
        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth, 
            height: chartContainer.clientHeight,
            layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#333' },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            timeScale: { 
                visible: !!props.showAxes, 
                borderColor: '#cccccc', 
                timeVisible: true, 
                secondsVisible: false 
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

    // ✨ [Refactor] 同步逻辑发送端：监听当前图表的视口变化，广播给父组件
    // 使用 getVisibleRange() 获取基于时间戳的范围
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        // 只有当此图表是用户当前激活（鼠标悬浮/操作）的图表时，才发送同步信号
        // 并且不能是在程序化设置过程中
        if (props.activeChartId === props.tokenInfo?.contractAddress && !isProgrammaticUpdate) {
            const timeRange = chart?.timeScale().getVisibleRange();
            if (timeRange && props.onViewportChange) {
                // lightweight-charts 返回的可能是 string 或 number，统一转 number
                props.onViewportChange({ 
                    from: Number(timeRange.from), 
                    to: Number(timeRange.to) 
                });
            }
        }
    });

    const payload = { address: info.contractAddress, chain: info.chain, interval: timeframe };

    // 通用数据处理函数
    const processData = (data: any[], isInitial: boolean) => {
        try {
            // 确保按时间排序
            const sortedData = data
                .map(d => ({ ...d, time: Number(d.time) }))
                .sort((a, b) => a.time - b.time);

            if (isInitial) {
                candlestickSeries?.setData(sortedData as CandlestickData<number>[]);
                
                // ✨ [Refactor] 初始化时应用同步状态
                // 如果有父组件传来的视口状态（时间范围），直接应用，否则 fitContent
                if (props.viewportState) {
                     chart?.timeScale().setVisibleRange({
                        from: props.viewportState.from as Time,
                        to: props.viewportState.to as Time
                    });
                } else {
                    chart?.timeScale().fitContent();
                }
            } else {
                // 处理历史数据补全 (Simple Merge)
                const currentData = (candlestickSeries?.data() as CandlestickData<number>[] || []);
                const newDataMap = new Map(currentData.map(d => [d.time, d]));
                sortedData.forEach(d => newDataMap.set(d.time as number, d as CandlestickData<number>));
                const merged = Array.from(newDataMap.values()).sort((a, b) => (a.time as number) - (b.time as number));
                candlestickSeries?.setData(merged);
                
                if (currentData.length === 0 && !props.viewportState) {
                    chart?.timeScale().fitContent();
                }
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

// ✨ [Refactor] 同步逻辑接收端：响应 ViewportState 变化
// 使用 setVisibleRange (基于时间) 而非 LogicalRange
createEffect(() => {
    const vs = props.viewportState;
    // 仅当存在 ViewportState 且当前图表 *不是* 用户正在操作的主动图表时，才进行被动同步
    if (chart && vs && props.activeChartId !== props.tokenInfo?.contractAddress) {
        isProgrammaticUpdate = true;
        try {
            chart.timeScale().setVisibleRange({
                from: vs.from as Time,
                to: vs.to as Time
            });
        } catch (e) {
            // 数据未加载完成时设置范围可能会失败，属于正常现象
            // console.warn("Sync warning:", e);
        }
        // 异步释放锁，确保此次 update 周期结束
        setTimeout(() => { isProgrammaticUpdate = false; }, 0);
    }
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
        // 鼠标移入时，标记此图表为 Active，它将成为同步源
        onMouseEnter={() => props.tokenInfo && props.onSetActiveChart?.(props.tokenInfo.contractAddress)}
        onMouseLeave={() => props.onSetActiveChart?.(null)}
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