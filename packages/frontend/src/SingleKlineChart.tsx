// packages/frontend/src/SingleKlineChart.tsx

/** @jsxImportSource solid-js */

import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries } from 'lightweight-charts';
import { socket } from './socket'; // ✨ 引入全局 socket 实例
import type { LightweightChartKline, KlineUpdatePayload, KlineFetchErrorPayload, KlineHistoryResponse } from './types';
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

// 优化格式化函数，处理科学计数法
const customPriceFormatter = (price: number): string => {
    if (price === 0) return '0';
    if (price < 0.000001) {
        return price.toFixed(12).replace(/\.?0+$/, "");
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
    const [lastBarIndex, setLastBarIndex] = createSignal<number | null>(null);
    let isSettingRangeProgrammatically = false;

    // 🏷️ 生成一个用于日志的唯一ID
    const getLogId = () => `[${props.tokenInfo?.symbol || '???'} @ ${props.timeframe}]`;

    const cleanupChart = () => {
        if (chart) {
            // console.log(`${getLogId()} Cleanup chart.`);
            chart.remove();
            chart = null;
            candlestickSeries = null;
            setLastBarIndex(null);
        }
    };

    const unsubscribeRealtime = (payload: { address: string; chain: string; interval: string }) => {
        console.log(`${getLogId()} 🔻 Unsubscribing realtime...`);
        socket.off('kline_update', handleKlineUpdate);
        socket.emit('unsubscribe_kline', payload);
    };
    
    const handleKlineUpdate = (update: KlineUpdatePayload) => {
        const info = props.tokenInfo;
        if (!info) return;
        const chainToPoolId: Record<string, number> = { bsc: 14, sol: 16, solana: 16, base: 199 };
        const poolId = chainToPoolId[info.chain.toLowerCase()];
        const expectedRoom = `kl@${poolId}@${info.contractAddress}@${props.timeframe}`;

        if (update.room === expectedRoom) {
            // console.log(`${getLogId()} ⚡ Realtime update received: ${update.data.time}`);
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
        setStatus(`Loading ${info.symbol}...`);
        
        if (!chartContainer) {
            return;
        }

        const logId = `[${info.symbol} @ ${timeframe}]`;
        console.log(`${logId} 🚀 Chart Initialization Started.`);

        try {
            chart = createChart(chartContainer, {
                width: chartContainer.clientWidth, 
                height: chartContainer.clientHeight,
                layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#333' },
                grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
                timeScale: { visible: !!props.showAxes, borderColor: '#cccccc', timeVisible: true, secondsVisible: false },
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

        // ✨ 调试日志：处理初始数据
        const handleInitialData = (response: any) => {
            // 1. 基本检查
            if (Array.isArray(response)) {
                console.error(`${logId} ❌ Received Array (Old Backend Format?)! Expecting Object.`);
                return;
            }

            // 2. 检查元数据匹配
            if (
                response.interval !== timeframe || 
                response.address.toLowerCase() !== info.contractAddress.toLowerCase()
            ) {
                // 忽略不匹配的数据（广播机制）
                return; 
            }

            const dataCount = response.data?.length || 0;
            console.log(`${logId} 📥 RX Initial Data. Count: ${dataCount}`);

            const data = response.data;
            if (data && data.length > 0) {
                try {
                    candlestickSeries?.setData(data as CandlestickData<number>[]);
                    setLastBarIndex(data.length - 1);
                    
                    const vs = props.viewportState;
                    if (vs) {
                        const to = data.length - 1 - vs.offset;
                        const from = to - vs.width;
                        setTimeout(() => chart?.timeScale().setVisibleLogicalRange({ from, to }), 0);
                    } else {
                        chart?.timeScale().fitContent();
                    }
                    setStatus(`Live: ${info.symbol} ${timeframe}`);
                } catch (e) {
                    console.error(`${logId} ❌ Failed to set initial data:`, e);
                }
            } else {
                console.warn(`${logId} ⚠️ Initial data was empty.`);
                setStatus(`Waiting for data...`);
            }
        };
        
        // ✨ 调试日志：处理完整数据 (API Fetch 结果)
        const handleCompletedData = (response: any) => {
            if (
                response.interval !== timeframe || 
                response.address.toLowerCase() !== info.contractAddress.toLowerCase()
            ) {
                return; 
            }

            const dataCount = response.data?.length || 0;
            console.log(`${logId} 📥 RX Completed Data (API). Count: ${dataCount}`);
            
            const data = response.data;
            if (data && data.length > 0) {
                try {
                    const currentData = (candlestickSeries?.data() as CandlestickData<number>[] || []);
                    // 合并数据逻辑
                    const newDataMap = new Map(currentData.map(d => [d.time, d]));
                    data.forEach((d: any) => newDataMap.set(d.time as number, d as CandlestickData<number>));
                    
                    const sortedData = Array.from(newDataMap.values()).sort((a, b) => (a.time as number) - (b.time as number));
                    
                    candlestickSeries?.setData(sortedData);
                    setLastBarIndex(sortedData.length - 1);
                    setStatus(`Live: ${info.symbol} ${timeframe}`);
                    
                    if (currentData.length === 0) {
                         chart?.timeScale().fitContent();
                    }

                } catch (e) {
                    console.error(`${logId} ❌ Failed to update completed data:`, e);
                }
            } else {
                 console.warn(`${logId} ⚠️ Completed data was empty.`);
            }
        };
        
        const handleFetchError = (err: KlineFetchErrorPayload) => {
             const key = `${info.contractAddress.toLowerCase()}@${info.chain.toLowerCase()}@${timeframe}`;
             if(err.key === key) {
                console.error(`${logId} ❌ Backend Report Error:`, err);
                setStatus(`Error: ${err.error}`);
             }
        };

        socket.on('historical_kline_initial', handleInitialData);
        socket.on('historical_kline_completed', handleCompletedData);
        socket.on('kline_fetch_error', handleFetchError);
        socket.on('kline_update', handleKlineUpdate);

        console.log(`${logId} 📤 Sending 'request_historical_kline' & 'subscribe_kline'`);
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
        if (chartContainer) {
            resizeObserver.observe(chartContainer);
        }
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