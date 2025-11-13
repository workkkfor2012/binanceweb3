// packages/frontend/src/SingleKlineChart.tsx
import { Component, onMount, onCleanup, createEffect, Show } from 'solid-js';
// ✨ 核心修改 1: 导入 LogicalRange
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries, LogicalRange } from 'lightweight-charts';
import KlineBrowserManager from './kline-browser-manager';
import type { LightweightChartKline } from './types';
import type { MarketItem } from 'shared-types';
import { ALL_TIMEFRAMES } from './ChartPageLayout';

const BACKEND_URL = 'http://localhost:3001';

// ✨ 核心修改 2: 更新 Props 接口
interface SingleKlineChartProps {
    tokenInfo: MarketItem | undefined;
    onBlock?: (contractAddress: string) => void;
    timeframe: string;
    visibleLogicalRange: LogicalRange | null;
    onVisibleLogicalRangeChange?: (range: LogicalRange) => void;
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

    let loadChartVersion = 0;
    let lastLoadedAddress: string | undefined = undefined;
    let lastLoadedTimeframe: string | undefined = undefined;
    let isSettingRangeProgrammatically = false;

    const cleanup = () => {
        klineManager?.stop();
        klineManager = null;
        if (chart) {
            chart.remove();
            chart = null;
        }
    };

    const loadChart = (addr: string, ch: string, interval: string) => {
        cleanup(); 
        loadChartVersion++;
        const currentVersion = loadChartVersion;
        if (!chartContainer) return;

        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: chartContainer.clientHeight,
            layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#333' },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            timeScale: {
                borderColor: '#cccccc', timeVisible: true, secondsVisible: false,
                barSpacing: 10, rightOffset: 10,
            },
            rightPriceScale: { visible: true, borderColor: '#cccccc' }, // 显示价格轴以便调试
            leftPriceScale: { visible: false },
            handleScroll: true,
            handleScale: true,
        });
        
        // ✨ 核心修改 3: 订阅 getVisibleLogicalRange 的变化
        chart.timeScale().subscribeVisibleLogicalRangeChange((newRange) => {
            if (newRange && props.onVisibleLogicalRangeChange && !isSettingRangeProgrammatically) {
                if (props.activeChartId === props.tokenInfo?.contractAddress) {
                    props.onVisibleLogicalRangeChange(newRange);
                }
            }
        });

        candlestickSeries = chart.addSeries(CandlestickSeries, {
            priceFormat: { type: 'price', precision: 8, minMove: 0.00000001, formatter: customPriceFormatter },
            upColor: '#28a745', downColor: '#dc3545',
            borderVisible: false,
            wickDownColor: '#dc3545', wickUpColor: '#28a745',
        });
        
        klineManager = new KlineBrowserManager(addr, ch, interval);

        klineManager.on('data', (initialData: LightweightChartKline[]) => {
            if (currentVersion !== loadChartVersion) return;
            if (candlestickSeries) {
                candlestickSeries.setData(initialData as CandlestickData<number>[]);
                
                // ✨ 核心修改 4: 数据加载后，应用 LogicalRange (如果存在)
                if (props.visibleLogicalRange) {
                     setTimeout(() => { if (chart) chart.timeScale().setVisibleLogicalRange(props.visibleLogicalRange!) }, 0);
                } else if (initialData.length > 0) {
                    chart?.timeScale().scrollToPosition(-5, false);
                } else {
                    chart?.timeScale().fitContent();
                }
            }
        });
        
        klineManager.on('update', (updatedCandle: LightweightChartKline) => {
            if (currentVersion !== loadChartVersion) return;
            candlestickSeries?.update(updatedCandle as CandlestickData<number>);
        });
        klineManager.start();
    };

    const prefetchOtherTimeframes = (addr: string, ch: string, activeTf: string) => {
        const otherTimeframes = ALL_TIMEFRAMES.filter(tf => tf !== activeTf);
        for (const tf of otherTimeframes) new KlineBrowserManager(addr, ch, tf).start();
    };

    createEffect(() => {
        const newRange = props.visibleLogicalRange;
        // ✨ 核心修改 5: 监听 LogicalRange 的变化并应用
        if (chart && newRange && props.activeChartId !== props.tokenInfo?.contractAddress) {
            const currentRange = chart.timeScale().getVisibleLogicalRange();
            if (currentRange && (newRange.from !== currentRange.from || newRange.to !== currentRange.to)) {
                isSettingRangeProgrammatically = true;
                chart.timeScale().setVisibleLogicalRange(newRange);
                setTimeout(() => { isSettingRangeProgrammatically = false; }, 100);
            }
        }
    });

    createEffect(() => {
        const info = props.tokenInfo;
        const tf = props.timeframe;
        const newAddress = info?.contractAddress;

        if (newAddress === lastLoadedAddress && tf === lastLoadedTimeframe) return;

        if (newAddress) {
            if (newAddress !== lastLoadedAddress) {
                // 当品种变化时，重置 LogicalRange 以避免奇怪的缩放
                if (props.onVisibleLogicalRangeChange) props.onVisibleLogicalRangeChange(null);
                prefetchOtherTimeframes(newAddress, info.chain, tf);
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
                    <img 
                        src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(props.tokenInfo!.icon!)}`} 
                        class="icon-small" 
                        alt={props.tokenInfo!.symbol}
                    />
                    <span class="symbol-title">{props.tokenInfo!.symbol}</span>
                    <span class="chain-badge">{props.tokenInfo!.chain.toUpperCase()}</span>
                    <button 
                        class="block-button" 
                        title={`屏蔽 ${props.tokenInfo!.symbol}`}
                        onClick={() => props.onBlock?.(props.tokenInfo!.contractAddress)}
                    >
                        🚫
                    </button>
                </Show>
            </div>
            <div ref={chartContainer!} class="chart-container" />
        </div>
    );
};

export default SingleKlineChart;