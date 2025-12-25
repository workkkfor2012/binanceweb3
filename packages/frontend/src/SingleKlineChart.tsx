import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import TokenAvatar from "./components/TokenAvatar.jsx";
import {
    createChart,
    ColorType,
    IChartApi,
    ISeriesApi,
    CandlestickData,
    CandlestickSeries,
    Time,
    LineSeries,
    HistogramSeries,
    MouseEventParams,
    HistogramData,
    LineData
} from 'lightweight-charts';
import { coreSocket, marketSocket, MARKET_BACKEND_URL } from "./socket.js";
import type { KlineUpdatePayload, KlineFetchErrorPayload, KlineTick } from './types.js';
import type { MarketItem, HotlistItem } from './types.js'; // 修正路径
import { ViewportState } from './ChartPageLayout.jsx';
import { ChartTheme } from './themes.js';
import {
    getIntervalSeconds,
    formatTimeInChina,
    formatBigNumber,
    customPriceFormatter,
    getAdaptivePriceFormat
} from "./utils.js";

const BACKEND_URL = MARKET_BACKEND_URL;

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
    simpleMode?: boolean;
}

interface LegendData {
    time: string;
    open: string;
    high: string;
    low: string;
    close: string;
    amount: string;
    changePercent: string;
    color: string;
}

const SingleKlineChart: Component<SingleKlineChartProps> = (props) => {
    let chartContainer: HTMLDivElement;
    let chart: IChartApi | null = null;
    let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
    let volumeSeries: ISeriesApi<'Histogram'> | null = null;
    let liquiditySeries: ISeriesApi<'Line'> | null = null;
    let ghostSeries: ISeriesApi<'Line'> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const [status, setStatus] = createSignal('Initializing...');
    const [legendData, setLegendData] = createSignal<LegendData | null>(null);

    let isProgrammaticUpdate = false;
    let isSyncPending = false;

    const getMyId = () => props.tokenInfo?.contractAddress || '';

    const cleanupChart = () => {
        if (chart) {
            chart.remove();
            chart = null;
            candlestickSeries = null;
            volumeSeries = null;
            liquiditySeries = null;
            ghostSeries = null;
        }
    };

    const unsubscribeRealtime = (payload: { address: string; chain: string; interval: string }) => {
        marketSocket.off('kline_update', handleKlineUpdate);
        marketSocket.emit('unsubscribe_kline', payload);
    };

    const updateLegend = (candle: CandlestickData<Time> | undefined, vol: HistogramData<Time> | undefined) => {
        if (!candle) return;
        const open = candle.open;
        const close = candle.close;
        const high = candle.high;
        const low = candle.low;
        const amount = vol?.value || 0;
        const change = ((close - open) / open) * 100;
        const isUp = close >= open;
        const color = isUp ? props.theme.candle.upColor : props.theme.candle.downColor;
        const timeStr = formatTimeInChina(Number(candle.time));

        setLegendData({
            time: timeStr,
            open: customPriceFormatter(open),
            high: customPriceFormatter(high),
            low: customPriceFormatter(low),
            close: customPriceFormatter(close),
            amount: formatBigNumber(amount),
            changePercent: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`,
            color: color
        });
    };

    const handleKlineUpdate = (update: KlineUpdatePayload) => {
        const info = props.tokenInfo;
        if (!info || !candlestickSeries) return;
        const chainToPoolId: Record<string, number> = { bsc: 14, sol: 16, solana: 16, base: 199 };
        const poolId = chainToPoolId[info.chain.toLowerCase()];
        if (!poolId) return;

        const expectedRoom = `kl@${poolId}@${info.contractAddress}@${props.timeframe}`;
        if (update.room === expectedRoom) {
            const newCandle = update.data as KlineTick;
            const currentData = candlestickSeries.data();
            if (currentData.length > 0) {
                const lastCandle = currentData[currentData.length - 1] as CandlestickData<Time>;
                if (newCandle.time < (lastCandle.time as number)) return;
            }
            candlestickSeries.update(newCandle as unknown as CandlestickData<Time>);

            if (volumeSeries && newCandle.volume !== undefined) {
                const isUp = newCandle.close >= newCandle.open;
                const avgPrice = (newCandle.open + newCandle.high + newCandle.low + newCandle.close) / 4;
                const amount = newCandle.volume * avgPrice;
                volumeSeries.update({
                    time: newCandle.time as unknown as Time,
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
            data.push({ time: (nowAligned - (i * intervalSec)) as unknown as Time, value: 0 });
        }
        return data as LineData<Time>[];
    };

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
            }
        }
    });

    createEffect(() => {
        const info = props.tokenInfo;
        const timeframe = props.timeframe;
        const t = props.theme;

        if (!info || !timeframe) { cleanupChart(); setStatus('No token selected.'); return; }
        cleanupChart(); setStatus(`Loading ${info.symbol}...`);

        if (!chartContainer) return;
        const container = chartContainer;

        try {
            chart = createChart(container, {
                width: container.clientWidth, height: container.clientHeight,
                layout: { background: { type: ColorType.Solid, color: t.layout.background }, textColor: t.layout.textColor },
                grid: { vertLines: { color: t.grid.vertLines }, horzLines: { color: t.grid.horzLines } },
                localization: {
                    locale: 'zh-CN',
                    timeFormatter: (time: number) => formatTimeInChina(time)
                },
                timeScale: {
                    visible: !!props.showAxes, borderColor: '#cccccc', timeVisible: true, secondsVisible: false,
                    rightOffset: 12, shiftVisibleRangeOnNewBar: true,
                    tickMarkFormatter: (time: number) => {
                        const date = new Date(time * 1000);
                        return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
                    }
                },
                rightPriceScale: { visible: !!props.showAxes, borderColor: '#cccccc', autoScale: true },
                leftPriceScale: { visible: true, autoScale: true, borderColor: '#9c27b0', scaleMargins: { top: 0.1, bottom: 0.1 } },
                handleScroll: true, handleScale: true,
                crosshair: { mode: 1 },
            });

            ghostSeries = chart.addSeries(LineSeries, { color: 'transparent', lineWidth: 0 as any, priceScaleId: 'ghost', crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
            chart.priceScale('ghost').applyOptions({ visible: false });
            ghostSeries.setData(generateGhostData(timeframe));

            volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume', precision: 2 }, priceScaleId: 'volume' });
            chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });

            const priceFormatWithFormatter = { ...getAdaptivePriceFormat((info as any).price || 0), formatter: customPriceFormatter };
            candlestickSeries = chart.addSeries(CandlestickSeries, { priceFormat: priceFormatWithFormatter, upColor: t.candle.upColor, downColor: t.candle.downColor, borderDownColor: t.candle.borderDownColor, borderUpColor: t.candle.borderUpColor, wickDownColor: t.candle.wickDownColor, wickUpColor: t.candle.wickUpColor, priceScaleId: 'right' });

            liquiditySeries = chart.addSeries(LineSeries, { color: '#9c27b0', lineWidth: 2, priceScaleId: 'left', crosshairMarkerVisible: true, lastValueVisible: true, priceLineVisible: false, title: 'Liq' });

            chart.subscribeCrosshairMove((param: MouseEventParams) => {
                if (!candlestickSeries || !volumeSeries) return;
                if (param.time) {
                    const candleData = param.seriesData.get(candlestickSeries) as CandlestickData<Time>;
                    const volumeData = param.seriesData.get(volumeSeries) as HistogramData<Time>;
                    if (candleData) updateLegend(candleData, volumeData);
                } else {
                    const candleData = candlestickSeries.data();
                    const volData = volumeSeries.data();
                    if (candleData.length > 0) {
                        updateLegend(candleData[candleData.length - 1] as CandlestickData<Time>, volData[volData.length - 1] as HistogramData<Time>);
                    }
                }
            });
        } catch (e) {
            console.error(`[Chart:${info.symbol}] Error:`, e);
            setStatus(`Chart Error`); return;
        }

        chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
            if (isProgrammaticUpdate) return;
            if (getMyId().toLowerCase() === props.activeChartId?.toLowerCase()) {
                if (!isSyncPending) {
                    isSyncPending = true;
                    requestAnimationFrame(() => {
                        const lr = chart?.timeScale().getVisibleLogicalRange();
                        if (lr && props.onViewportChange) props.onViewportChange({ from: lr.from, to: lr.to });
                        isSyncPending = false;
                    });
                }
            }
        });

        const payload = { address: info.contractAddress, chain: info.chain, interval: timeframe };

        const processData = (data: any[], isInitial: boolean, response?: any, isNew?: boolean) => {
            try {
                const sortedData = data.map(d => ({ ...d, time: Number(d.time) as unknown as Time })).sort((a, b) => (a.time as unknown as number) - (b.time as unknown as number));
                const volData = sortedData.map(d => {
                    const avgPrice = (d.open + d.high + d.low + d.close) / 4;
                    return { time: d.time, value: d.volume * avgPrice, color: (d.close >= d.open) ? t.candle.upColor : t.candle.downColor };
                });

                if (isInitial) {
                    if (isNew) liquiditySeries?.setData([]);
                    candlestickSeries?.setData(sortedData as unknown as CandlestickData<Time>[]);
                    volumeSeries?.setData(volData as HistogramData<Time>[]);
                    if (response?.liquidityHistory && liquiditySeries) {
                        const liqData = (response.liquidityHistory as { time: number; value: number }[]).map(p => ({ time: p.time as unknown as Time, value: p.value })).sort((a, b) => (a.time as unknown as number) - (b.time as unknown as number));
                        liquiditySeries.setData(liqData);
                    }
                    if (sortedData.length > 0) updateLegend(sortedData[sortedData.length - 1] as unknown as CandlestickData<Time>, volData[volData.length - 1] as HistogramData<Time>);
                    if (props.viewportState) chart?.timeScale().setVisibleLogicalRange({ from: props.viewportState.from, to: props.viewportState.to });
                    else chart?.timeScale().scrollToRealTime();
                } else {
                    const currentData = (candlestickSeries?.data() as CandlestickData<Time>[] || []);
                    const newDataMap = new Map(currentData.map(d => [d.time as unknown as number, d]));
                    sortedData.forEach(d => newDataMap.set(d.time as unknown as number, d as unknown as CandlestickData<Time>));
                    candlestickSeries?.setData(Array.from(newDataMap.values()).sort((a, b) => (a.time as unknown as number) - (b.time as unknown as number)) as unknown as CandlestickData<Time>[]);

                    const currentVolData = (volumeSeries?.data() as HistogramData<Time>[] || []);
                    const newVolMap = new Map(currentVolData.map(d => [d.time as unknown as number, d]));
                    volData.forEach(d => newVolMap.set(d.time as unknown as number, d as unknown as HistogramData<Time>));
                    volumeSeries?.setData(Array.from(newVolMap.values()).sort((a, b) => (a.time as unknown as number) - (b.time as unknown as number)) as unknown as HistogramData<Time>[]);
                }
                setStatus(`Live`);
            } catch (e) { console.error(`[Chart:${info.symbol}] Data Error:`, e); }
        };

        const handleHistoricalKlineInitial = (response: any) => {
            if (response.interval === timeframe && response.address.toLowerCase() === info.contractAddress.toLowerCase()) {
                if (response.data && response.data.length > 0) processData(response.data, true, response, true);
                else setStatus(`No Data`);
            }
        };
        const handleCompletedData = (response: any) => {
            if (response.interval === timeframe && response.address.toLowerCase() === info.contractAddress.toLowerCase()) {
                if (response.data && response.data.length > 0) processData(response.data, false, response);
            }
        };
        const handleFetchError = (err: KlineFetchErrorPayload) => {
            const key = `${info.contractAddress.toLowerCase()}@${info.chain.toLowerCase()}@${timeframe}`;
            if (err.key === key) setStatus(`Error`);
        };
        const handleLiquidityHistory = (response: any) => {
            if (response.address.toLowerCase() === info.contractAddress.toLowerCase() && response.liquidityHistory && liquiditySeries) {
                const liqData = (response.liquidityHistory as { time: number; value: number }[]).map(p => ({ time: p.time as unknown as Time, value: p.value })).sort((a, b) => (a.time as unknown as number) - (b.time as unknown as number));
                liquiditySeries.setData(liqData);
            }
        };
        const handleConnect = () => {
            marketSocket.emit('request_historical_kline', payload);
            marketSocket.emit('subscribe_kline', payload);
            coreSocket.emit('request_historical_liquidity', payload);
        };

        marketSocket.on('historical_kline_initial', handleHistoricalKlineInitial);
        marketSocket.on('historical_kline_completed', handleCompletedData);
        marketSocket.on('kline_fetch_error', handleFetchError);
        marketSocket.on('kline_update', handleKlineUpdate);
        marketSocket.on('connect', handleConnect);
        coreSocket.on('historical_liquidity_initial', handleLiquidityHistory);

        const handleDataBroadcast = (rawPayload: unknown) => {
            if (typeof rawPayload !== 'object' || rawPayload === null) return;
            const p = rawPayload as any;
            if (p.category !== 'hotlist') return;
            const myAddr = props.tokenInfo?.contractAddress?.toLowerCase();
            if (!myAddr) return;
            const item = (p.data as HotlistItem[]).find(d => d.contractAddress?.toLowerCase() === myAddr);
            if (item?.liquidity !== undefined && item.liquidity !== null && liquiditySeries) {
                const intervalSec = getIntervalSeconds(props.timeframe);
                const timeBucket = (Math.floor(Date.now() / 1000 / intervalSec) * intervalSec) as unknown as Time;
                const dataList = liquiditySeries.data();
                if (dataList.length > 0 && (timeBucket as unknown as number) < (dataList[dataList.length - 1].time as unknown as number)) return;
                liquiditySeries.update({ time: timeBucket, value: item.liquidity });
            }
        };
        coreSocket.on('data-broadcast', handleDataBroadcast);

        marketSocket.emit('request_historical_kline', payload);
        marketSocket.emit('subscribe_kline', payload);
        coreSocket.emit('request_historical_liquidity', payload);

        onCleanup(() => {
            unsubscribeRealtime(payload);
            marketSocket.off('historical_kline_initial', handleHistoricalKlineInitial);
            marketSocket.off('historical_kline_completed', handleCompletedData);
            marketSocket.off('kline_fetch_error', handleFetchError);
            marketSocket.off('kline_update', handleKlineUpdate);
            marketSocket.off('connect', handleConnect);
            coreSocket.off('historical_liquidity_initial', handleLiquidityHistory);
            coreSocket.off('data-broadcast', handleDataBroadcast);
            cleanupChart();
        });
    });

    createEffect(() => {
        const vs = props.viewportState;
        if (!chart || !vs || getMyId().toLowerCase() === props.activeChartId?.toLowerCase()) return;
        isProgrammaticUpdate = true;
        try { chart.timeScale().setVisibleLogicalRange({ from: vs.from, to: vs.to }); } catch (e) { }
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
        <div class="single-chart-wrapper" style={{ background: props.theme.layout.background, position: 'relative', width: '100%', height: '100%' }} onMouseEnter={() => props.onSetActiveChart?.(props.tokenInfo?.contractAddress || '')}>
            <Show when={!props.simpleMode}>
                <div class="chart-header" style={{ "background-color": props.theme.layout.background, "color": props.theme.layout.textColor, "border-bottom": `1px solid ${props.theme.grid.horzLines}` }}>
                    <Show when={props.tokenInfo} fallback={<span class="placeholder">{status()}</span>}>
                        <TokenAvatar symbol={props.tokenInfo!.symbol} src={props.tokenInfo!.icon ? `${BACKEND_URL}/image-proxy?url=${encodeURIComponent(props.tokenInfo!.icon!)}&symbol=${props.tokenInfo!.symbol}` : null} />
                        <span class="symbol-title">{props.tokenInfo!.symbol}</span>
                        <span class="chain-badge">{props.tokenInfo!.chain.toUpperCase()}</span>
                        <button class="block-button" title={`屏蔽 ${props.tokenInfo!.symbol}`} onClick={() => props.onBlock?.(props.tokenInfo!.contractAddress)}>🚫</button>
                    </Show>
                </div>
            </Show>

            <div class="chart-legend" style={{ position: 'absolute', top: props.simpleMode ? '4px' : '38px', left: '12px', "z-index": 10, "font-family": "monospace", "font-size": "11px", "pointer-events": "none", color: props.theme.layout.textColor }}>
                <Show when={legendData()}>
                    <div style={{ display: 'flex', gap: '15px', "flex-wrap": 'wrap' }}>
                        <span style={{ "font-weight": "bold", opacity: 0.8 }}>{legendData()!.time}</span>
                        <span>O:<span style={{ color: legendData()!.color }}>{legendData()!.open}</span></span>
                        <span>H:<span style={{ color: legendData()!.color }}>{legendData()!.high}</span></span>
                        <span>L:<span style={{ color: legendData()!.color }}>{legendData()!.low}</span></span>
                        <span>C:<span style={{ color: legendData()!.color }}>{legendData()!.close}</span></span>
                        <span>Amt:<span>{legendData()!.amount}</span></span>
                        <span style={{ color: legendData()!.color }}>({legendData()!.changePercent})</span>
                    </div>
                </Show>
            </div>
            <div ref={chartContainer!} class="chart-container" style={{ width: '100%', height: '100%' }} />
        </div>
    );
};

export default SingleKlineChart;