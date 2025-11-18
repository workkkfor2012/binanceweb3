// packages/frontend/src/SingleKlineChart.tsx
/** @jsxImportSource solid-js */
import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, LogicalRange } from 'lightweight-charts';
import { socket } from './socket'; // ✨ 引入全局 socket 实例
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
    if (price < 0.0001) return price.toPrecision(4);
    if (price < 1) return price.toFixed(6);
    return price.toFixed(2);
};

const SingleKlineChart: Component<SingleKlineChartProps> = (props) => {
    let chartContainer: HTMLDivElement;
    let chart: IChartApi | null = null;
    let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const [status, setStatus] = createSignal('Initializing...');
    const [lastBarIndex, setLastBarIndex] = createSignal<number | null>(null);
    let isSettingRangeProgrammatically = false;

    // --- 新的后端驱动的数据加载逻辑 ---
    
    const cleanupChart = () => {
        chart?.remove();
        chart = null;
        candlestickSeries = null;
        setLastBarIndex(null);
    };

    const unsubscribeRealtime = (payload: { address: string; chain: string; interval: string }) => {
        console.log(`[RT UNSUB] Unsubscribing from realtime updates for ${payload.address}`);
        socket.off('kline_update', handleKlineUpdate);
        socket.emit('unsubscribe_kline', payload);
    };
    
    // 统一的K线更新处理器
    const handleKlineUpdate = (update: KlineUpdatePayload) => {
        const info = props.tokenInfo;
        if (!info) return;
        // 简单的 room name 构造，用于匹配
        // 注意：这里的 poolId 需要和后端逻辑一致，这是一个潜在的脆弱点
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
        setStatus(`Loading ${info.symbol} ${timeframe} data...`);
        
        // 创建图表实例
        chart = createChart(chartContainer, { /* ... chart options ... */
             width: chartContainer.clientWidth, height: chartContainer.clientHeight,
            layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#333' },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            timeScale: { visible: !!props.showAxes, borderColor: '#cccccc', timeVisible: true, secondsVisible: false },
            rightPriceScale: { visible: !!props.showAxes, borderColor: '#cccccc' },
            leftPriceScale: { visible: false },
            handleScroll: true, handleScale: true,
        });

        candlestickSeries = chart.addSeries('Candlestick', {
            priceFormat: { type: 'price', precision: 8, minMove: 0.00000001, formatter: customPriceFormatter },
            upColor: '#28a745', downColor: '#dc3545', borderDownColor: '#dc3545',
            borderUpColor: '#28a745', wickDownColor: '#dc3545', wickUpColor: '#28a745',
        });
        
        // 뷰포트 변경 핸들러
        chart.timeScale().subscribeVisibleLogicalRangeChange((newRange) => {
            if (newRange && props.onViewportChange && !isSettingRangeProgrammatically) {
                if (props.activeChartId === props.tokenInfo?.contractAddress) {
                    const lbi = lastBarIndex();
                    if (lbi === null) return;
                    const width = newRange.to - newRange.from;
                    const offset = lbi - newRange.to;
                    props.onViewportChange({ width, offset });
                }
            }
        });


        const payload = { address: info.contractAddress, chain: info.chain, interval: timeframe };

        // --- 数据加载流程 ---
        const handleInitialData = (data: LightweightChartKline[]) => {
            if (data.length > 0) {
                candlestickSeries?.setData(data as CandlestickData<number>[]);
                setLastBarIndex(data.length - 1);
                // 同步其他图表的视口
                const vs = props.viewportState;
                if (vs) {
                     const to = data.length - 1 - vs.offset;
                     const from = to - vs.width;
                     setTimeout(() => chart?.timeScale().setVisibleLogicalRange({ from, to }), 0);
                } else {
                    chart?.timeScale().fitContent();
                }
            }
            setStatus(`Live: ${info.symbol} ${timeframe}`);
        };
        
        const handleCompletedData = (data: LightweightChartKline[]) => {
            const currentData = (candlestickSeries?.data() as CandlestickData<number>[] || []);
            const newDataMap = new Map(currentData.map(d => [d.time, d]));
            data.forEach(d => newDataMap.set(d.time as number, d as CandlestickData<number>));
            const sortedData = Array.from(newDataMap.values()).sort((a, b) => (a.time as number) - (b.time as number));
            candlestickSeries?.setData(sortedData);
            setLastBarIndex(sortedData.length - 1);
        };
        
        const handleFetchError = (err: KlineFetchErrorPayload) => {
             const key = `${info.contractAddress.toLowerCase()}@${info.chain.toLowerCase()}@${timeframe}`;
             if(err.key === key) {
                setStatus(`Error loading data for ${info.symbol}: ${err.error}`);
                console.error(`[KLINE_FETCH_ERROR]`, err);
             }
        };

        // 绑定监听器
        socket.on('historical_kline_initial', handleInitialData);
        socket.on('historical_kline_completed', handleCompletedData);
        socket.on('kline_fetch_error', handleFetchError);
        socket.on('kline_update', handleKlineUpdate);

        // 发起请求
        socket.emit('request_historical_kline', payload);
        socket.emit('subscribe_kline', payload); // 订阅实时更新

        onCleanup(() => {
            console.log(`[CLEANUP] Cleaning up chart for ${info.symbol} ${timeframe}`);
            unsubscribeRealtime(payload);
            socket.off('historical_kline_initial', handleInitialData);
            socket.off('historical_kline_completed', handleCompletedData);
            socket.off('kline_fetch_error', handleFetchError);
            cleanupChart();
        });
    });

    // Effect for syncing viewport from other charts
    createEffect(() => {
        const vs = props.viewportState;
        if (chart && vs && props.activeChartId !== props.tokenInfo?.contractAddress) {
            const lbi = lastBarIndex();
            if (lbi === null) return;
            const to = lbi - vs.offset;
            const from = to - vs.width;
            isSettingRangeProgrammatically = true;
            chart.timeScale().setVisibleLogicalRange({ from, to });
            setTimeout(() => { isSettingRangeProgrammatically = false; }, 100);
        }
    });

    onMount(() => {
        resizeObserver = new ResizeObserver(entries => {
            if (chart && chartContainer) {
                const { width, height } = entries[0].contentRect;
                chart.applyOptions({ width, height });
            }
        });
        resizeObserver.observe(chartContainer);
    });

    onCleanup(() => resizeObserver?.disconnect());
    
    return (
        <div 
            class="single-chart-wrapper"
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