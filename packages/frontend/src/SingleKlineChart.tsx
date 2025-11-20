// packages/frontend/src/SingleKlineChart.tsx

/** @jsxImportSource solid-js */

import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries, Time, LineSeries } from 'lightweight-charts';
import { socket } from './socket';
import type { LightweightChartKline, KlineUpdatePayload, KlineFetchErrorPayload } from './types';
import type { MarketItem } from 'shared-types';
import type { ViewportState } from './ChartPageLayout';

const BACKEND_URL = 'http://localhost:3001';

// --- 配置区 ---
// 强制补齐的K线数量，用于统一所有图表的X轴时间跨度，解决新老币种同步拖动不同步的问题
const FORCE_GHOST_CANDLE_COUNT = 1000;

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

// 辅助：获取时间周期的秒数
const getIntervalSeconds = (timeframe: string): number => {
const val = parseInt(timeframe);
if (timeframe.endsWith('m')) return val * 60;
if (timeframe.endsWith('h')) return val * 3600;
if (timeframe.endsWith('d')) return val * 86400;
return 60; // default 1m
};

const SingleKlineChart: Component<SingleKlineChartProps> = (props) => {
let chartContainer: HTMLDivElement;
let chart: IChartApi | null = null;
let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
let ghostSeries: ISeriesApi<'Line'> | null = null; // 👻 隐形系列引用
let resizeObserver: ResizeObserver | null = null;
const [status, setStatus] = createSignal('Initializing...');

// 🔒 状态锁
let isProgrammaticUpdate = false;
let isSyncPending = false;

const getMyId = () => props.tokenInfo?.contractAddress || '';

const cleanupChart = () => {
    if (chart) {
        chart.remove();
        chart = null;
        candlestickSeries = null;
        ghostSeries = null;
    }
};

const unsubscribeRealtime = (payload: { address: string; chain: string; interval: string }) => {
    socket.off('kline_update', handleKlineUpdate);
    socket.emit('unsubscribe_kline', payload);
};

const handleKlineUpdate = (update: KlineUpdatePayload) => {
    const info = props.tokenInfo;
    if (!info || !candlestickSeries) return;
    
    const chainToPoolId: Record<string, number> = { bsc: 14, sol: 16, solana: 16, base: 199 };
    const poolId = chainToPoolId[info.chain.toLowerCase()];
    const expectedRoom = `kl@${poolId}@${info.contractAddress}@${props.timeframe}`;

    if (update.room === expectedRoom) {
        const newCandle = update.data as CandlestickData<number>;
        
        // ✨✨✨ 核心修复：防止 "Cannot update oldest data" 错误 ✨✨✨
        // 获取当前系列中的所有数据
        const currentData = candlestickSeries.data();
        
        if (currentData.length > 0) {
            const lastCandle = currentData[currentData.length - 1] as CandlestickData<number>;
            // 只有当新数据的时间 >= 最后一根K线的时间时，才允许更新
            // 如果新数据时间比最后一条还早（乱序到达），则直接丢弃
            if (newCandle.time < lastCandle.time) {
                // console.warn(`[Chart] Dropped late packet. Last: ${lastCandle.time}, New: ${newCandle.time}`);
                return;
            }
        }
        
        candlestickSeries.update(newCandle);
    }
};

// 👻 生成隐形数据：从当前时间点倒推 N 根，确保时间轴被撑开
const generateGhostData = (timeframe: string) => {
    const intervalSec = getIntervalSeconds(timeframe);
    // 向下取整对齐时间，确保所有图表的刻度线垂直对齐
    const now = Math.floor(Date.now() / 1000 / intervalSec) * intervalSec;
    const data = [];
    for (let i = FORCE_GHOST_CANDLE_COUNT; i >= 0; i--) {
        data.push({
            time: (now - (i * intervalSec)) as Time,
            value: 0 // 价格为0，反正不显示
        });
    }
    return data;
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
                rightOffset: 12, 
                shiftVisibleRangeOnNewBar: true, // 必须开启，否则新数据会导致视图被挤压
                fixLeftEdge: false, // 允许拖动到数据左侧空白处
                fixRightEdge: false,
            },
            // 主价格轴 (右侧) - 用于真实K线
            rightPriceScale: { visible: !!props.showAxes, borderColor: '#cccccc', autoScale: true },
            // 👻 隐形价格轴 (左侧) - 用于Ghost Series，设为不可见
            leftPriceScale: { visible: false, autoScale: false }, 
            handleScroll: true, 
            handleScale: true,
        });

          ghostSeries = chart.addSeries(LineSeries, {
            color: 'rgba(0,0,0,0)', // 完全透明
            lineWidth: 1,
            priceScaleId: 'left',   // ✨ 绑定到左侧隐藏轴，防止干扰右侧主轴的自动缩放
            crosshairMarkerVisible: false,
            lastValueVisible: false,
            priceLineVisible: false,
        });
        // 设置 Ghost 数据
        ghostSeries.setData(generateGhostData(timeframe));

        // 2. 添加真实 K 线系列
        candlestickSeries = chart.addSeries(CandlestickSeries, {
            priceFormat: { 
                type: 'price', 
                precision: 10,
                minMove: 0.00000001, 
                formatter: customPriceFormatter 
            },
            upColor: '#28a745', downColor: '#dc3545', borderDownColor: '#dc3545',
            borderUpColor: '#28a745', wickDownColor: '#dc3545', wickUpColor: '#28a745',
            priceScaleId: 'right' // 明确绑定到右侧
        });

    } catch (e) {
        console.error(`${logId} ❌ Failed to create chart:`, e);
        setStatus(`Chart Error: ${e}`);
        return;
    }

    // [SENDER] 发送同步信号
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (isProgrammaticUpdate) return;

        const myId = getMyId().toLowerCase();
        const activeId = props.activeChartId?.toLowerCase();

        // 只有当前激活的图表（鼠标所在的图表）才有资格发送同步信号
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
                
                // 初始加载时的视口处理
                if (props.viewportState) {
                    // 如果父级有同步状态，优先听父级的
                     chart?.timeScale().setVisibleRange({
                        from: props.viewportState.from as Time,
                        to: props.viewportState.to as Time
                    });
                } else {
                    // 否则滚动到最新
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

// [RECEIVER] 接收同步信号
createEffect(() => {
    const vs = props.viewportState;
    if (!chart || !vs || !props.tokenInfo) return;

    const myId = getMyId().toLowerCase();
    const activeId = props.activeChartId?.toLowerCase();

    // 如果自己是触发源，则忽略更新，避免循环死锁
    if (myId === activeId) return;

    isProgrammaticUpdate = true;
    try {
        chart.timeScale().setVisibleRange({
            from: vs.from as Time,
            to: vs.to as Time
        });
    } catch (e) {
        // 偶尔极端情况可能报错，吞掉日志防止刷屏
    }
    
    // 立即释放锁
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