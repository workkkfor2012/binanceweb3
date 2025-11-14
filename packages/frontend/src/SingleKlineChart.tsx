// packages/frontend/src/SingleKlineChart.tsx
import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries, LogicalRange } from 'lightweight-charts';
import KlineBrowserManager from './kline-browser-manager';
import type { LightweightChartKline } from './types';
import type { MarketItem } from 'shared-types';
import { ALL_TIMEFRAMES, ViewportState } from './ChartPageLayout';

const BACKEND_URL = 'http://localhost:3001';

interface SingleKlineChartProps {
    tokenInfo: MarketItem | undefined;
    onBlock?: (contractAddress: string) => void;
    timeframe: string;
    viewportState: ViewportState | null;
    onViewportChange?: (state: ViewportState | null) => void;
    activeChartId: string | null;
    onSetActiveChart?: (id: string | null) => void;
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
    let klineManager: KlineBrowserManager | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const [lastBarIndex, setLastBarIndex] = createSignal<number | null>(null);

    let loadChartVersion = 0;
    let lastLoadedAddress: string | undefined = undefined;
    let lastLoadedTimeframe: string | undefined = undefined;
    let isSettingRangeProgrammatically = false;

    const cleanup = () => {
        klineManager?.stop();
        klineManager = null;
        if (chart) chart.remove();
        chart = null;
        setLastBarIndex(null);
    };

    const loadChart = (addr: string, ch: string, interval: string) => {
        cleanup(); 
        loadChartVersion++;
        const currentVersion = loadChartVersion;
        if (!chartContainer) return;

        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth, height: chartContainer.clientHeight,
            layout: { 
                background: { type: ColorType.Solid, color: '#ffffff' }, 
                textColor: '#333',
            },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            timeScale: { 
                visible: false, // 需求 3 (最终版): 完全不显示时间轴
            },
            rightPriceScale: { 
                visible: false, // 需求 1: 不显示价格坐标轴
            },
            leftPriceScale: { 
                visible: false, // 需求 1: 不显示价格坐标轴
            },
            handleScroll: true, handleScale: true,
        });
        
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

        candlestickSeries = chart.addSeries(CandlestickSeries, { /* ... options ... */ });
        
        klineManager = new KlineBrowserManager(addr, ch, interval);

        klineManager.on('data', (initialData: LightweightChartKline[]) => {
            if (currentVersion !== loadChartVersion) return;
            if (candlestickSeries) {
                candlestickSeries.setData(initialData as CandlestickData<number>[]);
                const newLastBarIndex = initialData.length > 0 ? initialData.length - 1 : null;
                setLastBarIndex(newLastBarIndex);

                const vs = props.viewportState;
                if (vs && newLastBarIndex !== null) {
                    const to = newLastBarIndex - vs.offset;
                    const from = to - vs.width;
                    setTimeout(() => chart?.timeScale().setVisibleLogicalRange({ from, to }), 0);
                } else {
                    chart?.timeScale().scrollToPosition(-5, false);
                }
            }
        });
        
        klineManager.on('update', (updatedCandle: LightweightChartKline) => {
            if (currentVersion !== loadChartVersion) return;
            candlestickSeries?.update(updatedCandle as CandlestickData<number>);
            const lbi = lastBarIndex();
            if (lbi !== null) setLastBarIndex(lbi + 1);
        });

        klineManager.start();
    };
    
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

    createEffect(() => {
        const info = props.tokenInfo;
        const tf = props.timeframe;
        const newAddress = info?.contractAddress;
        if (newAddress === lastLoadedAddress && tf === lastLoadedTimeframe) return;
        if (newAddress) {
            if (tf !== lastLoadedTimeframe && props.onViewportChange) {
                 props.onViewportChange(null);
            }
            if (newAddress !== lastLoadedAddress) {
                 const otherTimeframes = ALL_TIMEFRAMES.filter(t => t !== tf);
                 for (const otherTf of otherTimeframes) {
                     new KlineBrowserManager(newAddress, info.chain, otherTf).start();
                 }
            }
            lastLoadedAddress = newAddress;
            lastLoadedTimeframe = tf;
            loadChart(newAddress, info.chain, tf);
        } else {
            lastLoadedAddress = undefined;
            lastLoadedTimeframe = undefined;
            cleanup();
        }
    });
    onMount(() => {
        resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === chartContainer && chart) {
                    chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
                }
            }
        });
        resizeObserver.observe(chartContainer);
    });
    onCleanup(() => {
        resizeObserver?.disconnect();
        cleanup();
        loadChartVersion++;
    });

    return (
        <div 
            class="single-chart-wrapper"
            onMouseEnter={() => props.tokenInfo && props.onSetActiveChart?.(props.tokenInfo.contractAddress)}
            onMouseLeave={() => props.onSetActiveChart?.(null)}
        >
            <div class="chart-header">
                <Show when={props.tokenInfo} fallback={<span class="placeholder">点击左侧排名标题加载图表</span>}>
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