// packages/frontend/src/SingleKlineChart.tsx
/** @jsxImportSource solid-js */

import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { 
    createChart, 
    ColorType, 
    IChartApi, 
    ISeriesApi, 
    CandlestickData, 
    CandlestickSeries, 
    Time, 
    LineSeries, 
    PriceFormat,
    HistogramSeries 
} from 'lightweight-charts';
import { socket } from './socket';
import type { KlineUpdatePayload, KlineFetchErrorPayload, LightweightChartKline } from './types';
import type { MarketItem } from 'shared-types';
import type { ViewportState } from './ChartPageLayout';
import type { ChartTheme } from './themes';

const BACKEND_URL = 'http://localhost:3001';

// --- 配置区 ---
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
    theme: ChartTheme;
}

// 自适应精度计算
const getAdaptivePriceFormat = (price: number): PriceFormat => {
    if (!price || price <= 0) {
        return { type: 'price', precision: 4, minMove: 0.0001 };
    }

    let precision: number;

    if (price >= 1) {
        precision = 2;
    } else {
        const firstSignificantDigitPosition = Math.ceil(-Math.log10(price));
        precision = firstSignificantDigitPosition + 3;
    }

    const finalPrecision = Math.min(Math.max(precision, 2), 10);
    const minMove = 1 / Math.pow(10, finalPrecision);

    return {
        type: 'price',
        precision: finalPrecision,
        minMove: minMove,
    };
};


const customPriceFormatter = (price: number): string => {
    const s = new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 10,
        useGrouping: false
    }).format(price);
    
    if (s.includes('.')) {
        return s.replace(/\.?0+$/, '');
    }
    return s;
};

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
    let volumeSeries: ISeriesApi<'Histogram'> | null = null; 
    let ghostSeries: ISeriesApi<'Line'> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const [status, setStatus] = createSignal('Initializing...');

    // 🔒 状态锁
    let isProgrammaticUpdate = false;
    let isSyncPending = false;

    const getMyId = () => props.tokenInfo?.contractAddress || '';

    const log = (msg: string, ...args: any[]) => {
        // console.log(`[Chart ${props.tokenInfo?.symbol || 'Wait'}] ${msg}`, ...args);
    };

    const cleanupChart = () => {
        if (chart) {
            log('Cleaning up chart instance.');
            chart.remove();
            chart = null;
            candlestickSeries = null;
            volumeSeries = null;
            ghostSeries = null;
        }
    };

    const unsubscribeRealtime = (payload: { address: string; chain: string; interval: string }) => {
        socket.off('kline_update', handleKlineUpdate);
        socket.emit('unsubscribe_kline', payload);
    };

    // 实时数据更新处理函数
    const handleKlineUpdate = (update: KlineUpdatePayload) => {
        const info = props.tokenInfo;
        if (!info || !candlestickSeries) return;
        
        const chainToPoolId: Record<string, number> = { bsc: 14, sol: 16, solana: 16, base: 199 };
        const poolId = chainToPoolId[info.chain.toLowerCase()];
        if (!poolId) return;

        const expectedRoom = `kl@${poolId}@${info.contractAddress}@${props.timeframe}`;

        if (update.room === expectedRoom) {
            const newCandle = update.data as LightweightChartKline;
            const currentData = candlestickSeries.data();
            if (currentData.length > 0) {
                const lastCandle = currentData[currentData.length - 1] as CandlestickData<number>;
                if (newCandle.time < lastCandle.time) {
                    log(`⚠️ Dropped late packet. Last: ${lastCandle.time}, New: ${newCandle.time}`);
                    return;
                }
            }
            candlestickSeries.update(newCandle as CandlestickData<number>);

            // ✨ Update Volume (Approximate Turnover)
            if (volumeSeries && newCandle.volume !== undefined) {
                const isUp = newCandle.close >= newCandle.open;
                // ✨ 核心修改：使用 (O+H+L+C)/4 计算平均价格，从而得到更准确的成交额
                const avgPrice = (newCandle.open + newCandle.high + newCandle.low + newCandle.close) / 4;
                const amount = newCandle.volume * avgPrice;
                
                volumeSeries.update({
                    time: newCandle.time as Time,
                    value: amount,
                    color: isUp ? props.theme.candle.upColor : props.theme.candle.downColor
                });
            }
        }
    };

    const generateGhostData = (timeframe: string) => {
        const intervalSec = getIntervalSeconds(timeframe);
        const nowAligned = Math.floor(Date.now() / 1000 / intervalSec) * intervalSec;
        const data = [];
        for (let i = FORCE_GHOST_CANDLE_COUNT; i >= 0; i--) {
            data.push({ time: (nowAligned - (i * intervalSec)) as Time, value: 0 });
        }
        return data;
    };

    // ✨ Theme Application Effect
    createEffect(() => {
        if (chart && props.theme) {
            const t = props.theme;
            chart.applyOptions({
                layout: { background: { type: ColorType.Solid, color: t.layout.background }, textColor: t.layout.textColor },
                grid: { vertLines: { color: t.grid.vertLines }, horzLines: { color: t.grid.horzLines } },
            });
            
            if (candlestickSeries) {
                candlestickSeries.applyOptions({
                    upColor: t.candle.upColor, downColor: t.candle.downColor,
                    borderUpColor: t.candle.borderUpColor, borderDownColor: t.candle.borderDownColor,
                    wickUpColor: t.candle.wickUpColor, wickDownColor: t.candle.wickDownColor,
                });

                // ✨ Sync Volume Colors with Theme
                if (volumeSeries) {
                    const candles = candlestickSeries.data() as CandlestickData<number>[];
                    const volumes = volumeSeries.data() as any[]; 
                    
                    if (candles.length === volumes.length && candles.length > 0) {
                        const newVolData = volumes.map((v, i) => {
                            const c = candles[i];
                            const isUp = c.close >= c.open;
                            return {
                                time: v.time,
                                value: v.value,
                                color: isUp ? t.candle.upColor : t.candle.downColor
                            };
                        });
                        volumeSeries.setData(newVolData);
                    }
                }
            }
        }
    });

    // 主副作用：图表创建与数据订阅
    createEffect(() => {
        const info = props.tokenInfo;
        const timeframe = props.timeframe;
        const t = props.theme; 

        if (!info || !timeframe) {
            cleanupChart(); setStatus('No token selected.'); return;
        }

        cleanupChart(); setStatus(`Loading ${info.symbol}...`);
        
        if (!chartContainer) return;

        try {
            chart = createChart(chartContainer, {
                width: chartContainer.clientWidth, height: chartContainer.clientHeight,
                layout: { background: { type: ColorType.Solid, color: t.layout.background }, textColor: t.layout.textColor },
                grid: { vertLines: { color: t.grid.vertLines }, horzLines: { color: t.grid.horzLines } },
                timeScale: { 
                    visible: !!props.showAxes, borderColor: '#cccccc', timeVisible: true, secondsVisible: false,
                    rightOffset: 12, shiftVisibleRangeOnNewBar: true, fixLeftEdge: false, fixRightEdge: false, 
                },
                rightPriceScale: { visible: !!props.showAxes, borderColor: '#cccccc', autoScale: true },
                leftPriceScale: { visible: false, autoScale: false }, 
                handleScroll: true, handleScale: true,
            });

            ghostSeries = chart.addSeries(LineSeries, {
                color: 'rgba(0,0,0,0)', lineWidth: 1, priceScaleId: 'left',   
                crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false,
            });
            ghostSeries.setData(generateGhostData(timeframe));

            // ✨ 先创建 Series，注册 ID 'volume'
            volumeSeries = chart.addSeries(HistogramSeries, {
                priceFormat: { 
                    type: 'volume', 
                    precision: 2, // 金额通常保留2位或0位小数
                },
                priceScaleId: 'volume', 
            });

            // ✨ 配置 'volume' Scale
            chart.priceScale('volume').applyOptions({
                scaleMargins: {
                    top: 0.8, 
                    bottom: 0,
                },
                visible: false, 
            });

            const priceFormatWithFormatter = {
                ...getAdaptivePriceFormat(info.price || 0),
                formatter: customPriceFormatter,
            };

            candlestickSeries = chart.addSeries(CandlestickSeries, {
                priceFormat: priceFormatWithFormatter,
                upColor: t.candle.upColor, downColor: t.candle.downColor, 
                borderDownColor: t.candle.borderDownColor, borderUpColor: t.candle.borderUpColor, 
                wickDownColor: t.candle.wickDownColor, wickUpColor: t.candle.wickUpColor,
                priceScaleId: 'right'
            });

        } catch (e) {
            console.error(`[Chart:${info.symbol}] ❌ Fatal Error creating chart:`, e);
            setStatus(`Chart Error`); return;
        }

        chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
            if (isProgrammaticUpdate) return;
            const myId = getMyId().toLowerCase();
            const activeId = props.activeChartId?.toLowerCase();
            if (myId === activeId) {
                if (!isSyncPending) {
                    isSyncPending = true;
                    requestAnimationFrame(() => {
                        const logicalRange = chart?.timeScale().getVisibleLogicalRange();
                        if (logicalRange && props.onViewportChange) {
                            props.onViewportChange({ from: logicalRange.from, to: logicalRange.to });
                        }
                        isSyncPending = false;
                    });
                }
            }
        });

        const payload = { address: info.contractAddress, chain: info.chain, interval: timeframe };

        const processData = (data: any[], isInitial: boolean) => {
            try {
                const sortedData = data.map(d => ({ ...d, time: Number(d.time) })).sort((a, b) => a.time - b.time);
                
                // ✨ Prepare Volume Data (Calculated as Amount using OHLC Avg)
                const volData = sortedData.map(d => {
                    // ✨ 核心修改：使用 (O+H+L+C)/4
                    const avgPrice = (d.open + d.high + d.low + d.close) / 4;
                    return {
                        time: d.time,
                        value: d.volume * avgPrice,
                        color: (d.close >= d.open) ? t.candle.upColor : t.candle.downColor
                    };
                });

                if (isInitial) {
                    candlestickSeries?.setData(sortedData as CandlestickData<number>[]);
                    volumeSeries?.setData(volData);
                    
                    if (props.viewportState) {
                         chart?.timeScale().setVisibleLogicalRange({ from: props.viewportState.from, to: props.viewportState.to });
                    } else { chart?.timeScale().scrollToRealTime(); }
                } else {
                    // Merge Candles
                    const currentData = (candlestickSeries?.data() as CandlestickData<number>[] || []);
                    const newDataMap = new Map(currentData.map(d => [d.time, d]));
                    sortedData.forEach(d => newDataMap.set(d.time as number, d as CandlestickData<number>));
                    const merged = Array.from(newDataMap.values()).sort((a, b) => (a.time as number) - (b.time as number));
                    candlestickSeries?.setData(merged);

                    // ✨ Merge Volume
                    const currentVolData = (volumeSeries?.data() as any[] || []);
                    const newVolMap = new Map(currentVolData.map(d => [d.time, d]));
                    volData.forEach(d => newVolMap.set(d.time as number, d));
                    const mergedVol = Array.from(newVolMap.values()).sort((a: any, b: any) => a.time - b.time);
                    volumeSeries?.setData(mergedVol);
                }
                setStatus(`Live`);
            } catch (e) { console.error(`[Chart:${info.symbol}] ❌ Failed to process data:`, e); }
        };

        const handleInitialData = (response: any) => {
            if (response.interval !== timeframe || response.address.toLowerCase() !== info.contractAddress.toLowerCase()) return;
            if (response.data && response.data.length > 0) processData(response.data, true);
            else setStatus(`No Data`);
        };
        const handleCompletedData = (response: any) => {
            if (response.interval !== timeframe || response.address.toLowerCase() !== info.contractAddress.toLowerCase()) return;
            if (response.data && response.data.length > 0) processData(response.data, false);
        };
        const handleFetchError = (err: KlineFetchErrorPayload) => {
             const key = `${info.contractAddress.toLowerCase()}@${info.chain.toLowerCase()}@${timeframe}`;
             if(err.key === key) { log(`❌ Fetch error: ${err.error}`); setStatus(`Error`); }
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

    // [RECEIVER] 接收逻辑索引同步
    createEffect(() => {
        const vs = props.viewportState;
        if (!chart || !vs || !props.tokenInfo) return;
        const myId = getMyId().toLowerCase();
        const activeId = props.activeChartId?.toLowerCase();
        if (myId === activeId) return;
        isProgrammaticUpdate = true;
        try {
            chart.timeScale().setVisibleLogicalRange({ from: vs.from, to: vs.to });
        } catch (e) { }
        setTimeout(() => { isProgrammaticUpdate = false; }, 0);
    });

    onMount(() => {
        resizeObserver = new ResizeObserver(entries => {
            if (chart && chartContainer) {
                const { width, height } = entries[0].contentRect;
                chart.applyOptions({ width, height });
            }
        });
        if (chartContainer) resizeObserver.observe(chartContainer);
    });

    onCleanup(() => resizeObserver?.disconnect());

    return (
        <div 
            class="single-chart-wrapper"
            style={{ background: props.theme.layout.background }} 
            onMouseEnter={() => props.onSetActiveChart?.(props.tokenInfo?.contractAddress || '')}
        >
            <div 
                class="chart-header"
                style={{
                    "background-color": props.theme.layout.background,
                    "color": props.theme.layout.textColor,
                    "border-bottom": `1px solid ${props.theme.grid.horzLines}`
                }}
            >
                <Show when={props.tokenInfo} fallback={<span class="placeholder" style={{color: props.theme.layout.textColor}}>{status()}</span>}>
                    <img src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(props.tokenInfo!.icon!)}`} class="icon-small" alt={props.tokenInfo!.symbol}/>
                    <span class="symbol-title" style={{ color: props.theme.layout.textColor }}>{props.tokenInfo!.symbol}</span>
                    <span class="chain-badge">{props.tokenInfo!.chain.toUpperCase()}</span>
                    <button 
                        class="block-button" 
                        title={`屏蔽 ${props.tokenInfo!.symbol}`} 
                        onClick={() => props.onBlock?.(props.tokenInfo!.contractAddress)}
                        style={{ color: props.theme.layout.textColor }}
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