// packages/frontend/src/SingleKlineChart.tsx
import { Component, onMount, onCleanup, createEffect, Show } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries } from 'lightweight-charts';
import KlineBrowserManager, { LightweightChartKline } from './kline-browser-manager';
import type { MarketItem } from 'shared-types';

const BACKEND_URL = 'http://localhost:3001';

interface SingleKlineChartProps {
    tokenInfo: MarketItem | undefined;
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

    const cleanup = () => {
        klineManager?.stop();
        klineManager = null;
        chart?.remove();
        chart = null;
    };

    const loadChart = (addr: string, ch: string) => {
        cleanup(); 

        if (!chartContainer) return;

        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: chartContainer.clientHeight,
            layout: {
                background: { type: ColorType.Solid, color: '#ffffff' },
                textColor: '#333',
            },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            timeScale: {
                borderColor: '#cccccc', 
                timeVisible: true, 
                secondsVisible: false,
                barSpacing: 10,
                rightOffset: 10,
            },
            rightPriceScale: {
                visible: false,
            },
            leftPriceScale: {
                visible: false,
            },
            handleScroll: true,
            handleScale: true,
        });

        candlestickSeries = chart.addSeries(CandlestickSeries, {
            priceFormat: { type: 'price', precision: 8, minMove: 0.00000001, formatter: customPriceFormatter },
            upColor: '#28a745', downColor: '#dc3545',
            borderVisible: false,
            wickDownColor: '#dc3545', wickUpColor: '#28a745',
        });

        klineManager = new KlineBrowserManager(addr, ch);

        klineManager.on('data', (initialData: LightweightChartKline[]) => {
            if (candlestickSeries) {
                candlestickSeries.setData(initialData as CandlestickData<number>[]);
                
                // ✨ 核心修正 1: 控制初始K线位置
                if (initialData.length > 0) {
                    // 滚动到最新的K线，同时尊重 rightOffset
                    chart?.timeScale().scrollToPosition(initialData.length - 1, false);
                } else {
                    // 如果没有历史数据，则居中显示
                    chart?.timeScale().fitContent();
                }
            }
        });
        
        klineManager.on('update', (updatedCandle: LightweightChartKline) => {
            candlestickSeries?.update(updatedCandle as CandlestickData<number>);
        });

        klineManager.start();
    };

    createEffect(() => {
        const info = props.tokenInfo;
        if (info && info.contractAddress && info.chain) {
            loadChart(info.contractAddress, info.chain);
        } else {
            cleanup();
        }
    });

    onMount(() => {
        resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === chartContainer) {
                    chart?.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
                }
            }
        });
        resizeObserver.observe(chartContainer);
    });

    onCleanup(() => {
        resizeObserver?.disconnect();
        cleanup();
    });

    return (
        <div class="single-chart-wrapper">
            <div class="chart-header">
                <Show when={props.tokenInfo} fallback={<span class="placeholder">点击左侧排名标题加载图表</span>}>
                    <img 
                        src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(props.tokenInfo!.icon!)}`} 
                        class="icon-small" 
                        alt={props.tokenInfo!.symbol}
                    />
                    <span class="symbol-title">{props.tokenInfo!.symbol}</span>
                    <span class="chain-badge">{props.tokenInfo!.chain.toUpperCase()}</span>
                </Show>
            </div>
            <div ref={chartContainer!} class="chart-container" />
        </div>
    );
};

export default SingleKlineChart;