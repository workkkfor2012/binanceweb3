// packages/frontend/src/SingleKlineChart.tsx
/** @jsxImportSource solid-js */
import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries, LogicalRange } from 'lightweight-charts';
import KlineBrowserManager from './kline-browser-manager';
import type { LightweightChartKline } from './types';
import type { MarketItem } from 'shared-types';
import { ViewportState } from './ChartPageLayout';

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
    let klineManager: KlineBrowserManager | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const [lastBarIndex, setLastBarIndex] = createSignal<number | null>(null);

    let loadChartVersion = 0;
    let lastLoadedAddress: string | undefined = undefined;
    let lastLoadedTimeframe: string | undefined = undefined;
    let isSettingRangeProgrammatically = false;

    const cleanup = () => {
        const symbol = props.tokenInfo?.symbol || 'N/A';
        const tf = props.timeframe || 'N/A';
        console.log(`[ChartComponent ${symbol}@${tf}] Running cleanup...`);
        klineManager?.stop();
        klineManager = null;
        if (chart) chart.remove();
        chart = null;
        setLastBarIndex(null);
    };

    const loadChart = (addr: string, ch: string, interval: string) => { // <-- loadChart 签名恢复
        cleanup(); 
        loadChartVersion++;
        const currentVersion = loadChartVersion;
        const symbol = props.tokenInfo?.symbol;
        console.log(`[ChartComponent ${symbol}@${interval}] 🚀 --- LOAD CHART (Version: ${currentVersion}) ---`);
        if (!chartContainer) return;

        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth, height: chartContainer.clientHeight,
            layout: { 
                background: { type: ColorType.Solid, color: '#ffffff' }, 
                textColor: '#333',
            },
            grid: { 
                vertLines: { color: '#f0f3fa' }, 
                horzLines: { color: '#f0f3fa' } 
            },
            timeScale: { 
                visible: !!props.showAxes,
                borderColor: '#cccccc',
                timeVisible: true,
                secondsVisible: false,
            },
            rightPriceScale: { 
                visible: !!props.showAxes,
                borderColor: '#cccccc',
            },
            leftPriceScale: { visible: false },
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

        candlestickSeries = chart.addSeries(CandlestickSeries, {
            priceFormat: {
                type: 'price',
                precision: 8,
                minMove: 0.00000001,
                formatter: customPriceFormatter,
            },
            upColor: '#28a745',
            downColor: '#dc3545',
            borderDownColor: '#dc3545',
            borderUpColor: '#28a745',
            wickDownColor: '#dc3545',
            wickUpColor: '#28a745',
        });
        
        // <-- 构造函数调用恢复
        klineManager = new KlineBrowserManager(addr, ch, interval);

        klineManager.on('data', (initialData: LightweightChartKline[]) => {
            console.log(`[ChartComponent ${symbol}@${interval}] 📦 Received 'data' event. My version: ${currentVersion}, Global version: ${loadChartVersion}, Data length: ${initialData.length}`);
            if (currentVersion !== loadChartVersion) {
                console.warn(`[ChartComponent ${symbol}@${interval}] ⚠️ Aborting data load. Version mismatch.`);
                return;
            }
            if (candlestickSeries && initialData.length > 0) {
                console.log(`[ChartComponent ${symbol}@${interval}] ✅ Versions match. Calling setData with ${initialData.length} candles.`);
                candlestickSeries.setData(initialData as CandlestickData<number>[]);
                const newLastBarIndex = initialData.length - 1;
                setLastBarIndex(newLastBarIndex);

                const vs = props.viewportState;
                if (vs && newLastBarIndex !== null) {
                    const to = newLastBarIndex - vs.offset;
                    const from = to - vs.width;
                    setTimeout(() => chart?.timeScale().setVisibleLogicalRange({ from, to }), 0);
                } else {
                    chart?.timeScale().fitContent();
                }
            } else {
                 console.log(`[ChartComponent ${symbol}@${interval}] 🤔 Data received, but series is not ready or data is empty.`);
            }
        });
        
        klineManager.on('update', (updatedCandle: LightweightChartKline) => {
            if (currentVersion !== loadChartVersion) return;
            candlestickSeries?.update(updatedCandle as CandlestickData<number>);
        });

        console.log(`[ChartComponent ${symbol}@${interval}] Starting KlineManager...`);
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
        
        console.log(`[ChartComponent ${info?.symbol}@${tf}] EFFECT TRIGGERED. New Address: ${newAddress}, Last Address: ${lastLoadedAddress}`);

        if (newAddress === lastLoadedAddress && tf === lastLoadedTimeframe) {
            console.log(`[ChartComponent ${info?.symbol}@${tf}] > Props changed but address and timeframe are the same. Skipping chart reload.`);
            return;
        }

        if (newAddress) {
            console.log(`[ChartComponent ${info?.symbol}@${tf}] > Address or timeframe changed. Proceeding to load chart.`);
            if (tf !== lastLoadedTimeframe && props.onViewportChange) {
                 props.onViewportChange(null);
            }
            
            lastLoadedAddress = newAddress;
            lastLoadedTimeframe = tf;
            setTimeout(() => loadChart(newAddress!, info!.chain, tf), 0); // <-- 调用恢复
        } else {
            console.log(`[ChartComponent] > Token info is undefined. Cleaning up.`);
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
        console.log(`[ChartComponent ${props.tokenInfo?.symbol}@${props.timeframe}] Component is unmounting. Full cleanup.`);
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
                <Show when={props.tokenInfo} fallback={<span class="placeholder">...</span>}>
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