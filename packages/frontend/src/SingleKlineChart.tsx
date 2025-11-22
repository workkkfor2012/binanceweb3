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
    HistogramSeries,
    MouseEventParams 
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

// --- ✨ 新增: 图例数据接口 ---
interface LegendData {
    open: string;
    high: string;
    low: string;
    close: string;
    amount: string;
    changePercent: string;
    color: string; // 用于涨跌幅颜色
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

// ✨ 辅助: 格式化大额数字 (1.2M, 500K)
const formatBigNumber = (num: number): string => {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K';
    return num.toFixed(2);
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
    
    // ✨ 新增: 图例数据 Signal
    const [legendData, setLegendData] = createSignal<LegendData | null>(null);

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

    // ✨ 辅助: 更新图例逻辑 (复用代码)
    const updateLegend = (candle: CandlestickData<number> | undefined, vol: any | undefined) => {
        if (!candle) {
            // 如果没有数据，可以清空或保持最后状态，这里选择不处理
            return;
        }
        const open = candle.open;
        const close = candle.close;
        const high = candle.high;
        const low = candle.low;
        // 上一轮我们将 value 存为了 amount
        const amount = vol?.value || 0; 
        
        const change = ((close - open) / open) * 100;
        const isUp = close >= open;
        const color = isUp ? props.theme.candle.upColor : props.theme.candle.downColor;

        setLegendData({
            open: customPriceFormatter(open),
            high: customPriceFormatter(high),
            low: customPriceFormatter(low),
            close: customPriceFormatter(close),
            amount: formatBigNumber(amount),
            changePercent: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
            color: color
        });
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
                    return;
                }
            }
            candlestickSeries.update(newCandle as CandlestickData<number>);

            // Update Volume (Approximate Turnover)
            if (volumeSeries && newCandle.volume !== undefined) {
                const isUp = newCandle.close >= newCandle.open;
                const avgPrice = (newCandle.open + newCandle.high + newCandle.low + newCandle.close) / 4;
                const amount = newCandle.volume * avgPrice;
                
                volumeSeries.update({
                    time: newCandle.time as Time,
                    value: amount,
                    color: isUp ? props.theme.candle.upColor : props.theme.candle.downColor
                });

                // ✨ 如果鼠标不在图表上（或图表没有焦点），实时更新最新一根 K 线的图例
                // 这里做一个简单的判断，直接更新（如果在查看历史，鼠标移动事件会覆盖这个）
                // 为了更平滑的体验，通常只在鼠标移出后才由实时数据主导，
                // 但因为 lightweight-charts 没有直接的 "isHovering" 状态，
                // 我们依靠 subscribeCrosshairMove 来处理。
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

    // Theme Application Effect
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

                // Sync Volume Colors with Theme
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
                // ✨ 优化: 允许十字光标在任意点显示
                crosshair: {
                    mode: 1, // Magnet mode
                }
            });

            ghostSeries = chart.addSeries(LineSeries, {
                color: 'rgba(0,0,0,0)', lineWidth: 1, priceScaleId: 'left',   
                crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false,
            });
            ghostSeries.setData(generateGhostData(timeframe));

            // Volume Series
            volumeSeries = chart.addSeries(HistogramSeries, {
                priceFormat: { type: 'volume', precision: 2 },
                priceScaleId: 'volume', 
            });

            chart.priceScale('volume').applyOptions({
                scaleMargins: { top: 0.8, bottom: 0 },
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

            // ✨ 核心功能: 监听十字光标移动，更新图例
            chart.subscribeCrosshairMove((param: MouseEventParams) => {
                if (!candlestickSeries || !volumeSeries) return;

                // 如果鼠标在有效区域
                if (param.time) {
                    const candleData = param.seriesData.get(candlestickSeries) as CandlestickData<number>;
                    const volumeData = param.seriesData.get(volumeSeries) as any;
                    if (candleData) {
                        updateLegend(candleData, volumeData);
                    }
                } else {
                    // 鼠标移出，显示最后一根 K 线的数据
                    const candleData = candlestickSeries.data();
                    const volData = volumeSeries.data();
                    if (candleData.length > 0) {
                        const lastCandle = candleData[candleData.length - 1] as CandlestickData<number>;
                        const lastVol = volData[volData.length - 1];
                        updateLegend(lastCandle, lastVol);
                    }
                }
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
                
                const volData = sortedData.map(d => {
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
                    
                    // ✨ 初始化图例显示最后一根 K 线
                    if (sortedData.length > 0) {
                        const lastCandle = sortedData[sortedData.length - 1] as CandlestickData<number>;
                        const lastVol = volData[volData.length - 1];
                        updateLegend(lastCandle, lastVol);
                    }

                    if (props.viewportState) {
                         chart?.timeScale().setVisibleLogicalRange({ from: props.viewportState.from, to: props.viewportState.to });
                    } else { chart?.timeScale().scrollToRealTime(); }
                } else {
                    const currentData = (candlestickSeries?.data() as CandlestickData<number>[] || []);
                    const newDataMap = new Map(currentData.map(d => [d.time, d]));
                    sortedData.forEach(d => newDataMap.set(d.time as number, d as CandlestickData<number>));
                    const merged = Array.from(newDataMap.values()).sort((a, b) => (a.time as number) - (b.time as number));
                    candlestickSeries?.setData(merged);

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
            style={{ background: props.theme.layout.background, position: 'relative' }} 
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

            {/* ✨ 新增: 悬浮图例 UI */}
            <div 
                class="chart-legend" 
                style={{
                    position: 'absolute',
                    top: '38px', // 躲开 chart-header
                    left: '12px',
                    "z-index": 10,
                    "font-family": "'Courier New', monospace", // 等宽字体对齐数字
                    "font-size": "11px",
                    "pointer-events": "none", // 确保鼠标事件穿透到图表
                    "background-color": "rgba(255, 255, 255, 0.0)", // 透明背景
                    color: props.theme.layout.textColor
                }}
            >
                <Show when={legendData()}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <span>O:<span style={{color: legendData()!.color}}>{legendData()!.open}</span></span>
                        <span>H:<span style={{color: legendData()!.color}}>{legendData()!.high}</span></span>
                        <span>L:<span style={{color: legendData()!.color}}>{legendData()!.low}</span></span>
                        <span>C:<span style={{color: legendData()!.color}}>{legendData()!.close}</span></span>
                        <span>Amt:<span style={{color: props.theme.layout.textColor}}>{legendData()!.amount}</span></span>
                        <span style={{color: legendData()!.color}}>({legendData()!.changePercent})</span>
                    </div>
                </Show>
            </div>

            <div ref={chartContainer!} class="chart-container" />
        </div>
    );
};

export default SingleKlineChart;