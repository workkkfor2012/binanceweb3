// packages/frontend/src/SingleKlineChart.tsx

/** @jsxImportSource solid-js */

import { Component, onMount, onCleanup, createEffect, Show, createSignal } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries, Time, LineSeries } from 'lightweight-charts';
import { socket } from './socket';
import type { KlineUpdatePayload, KlineFetchErrorPayload } from './types';
import type { MarketItem } from 'shared-types';
import type { ViewportState } from './ChartPageLayout';

const BACKEND_URL = 'http://localhost:3001';

// --- 配置区 ---
// 强制补齐的K线数量，确保新币种也能拥有足够长的“时间骨架”以支持同步拖动
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
        return price.toFixed(12).replace(/\.?0+$/, "");
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
    let ghostSeries: ISeriesApi<'Line'> | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const [status, setStatus] = createSignal('Initializing...');

    // 🔒 状态锁：防止视口同步产生的死循环
    let isProgrammaticUpdate = false;
    let isSyncPending = false;

    const getMyId = () => props.tokenInfo?.contractAddress || '';

    const log = (msg: string, ...args: any[]) => {
        // 仅在开发模式或需要调试特定图表时开启
        // console.log(`[Chart ${props.tokenInfo?.symbol || 'Wait'}] ${msg}`, ...args);
    };

    const cleanupChart = () => {
        if (chart) {
            log('Cleaning up chart instance.');
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

    // 实时数据更新处理函数
    const handleKlineUpdate = (update: KlineUpdatePayload) => {
        const info = props.tokenInfo;
        if (!info || !candlestickSeries) return;
        
        const chainToPoolId: Record<string, number> = { bsc: 14, sol: 16, solana: 16, base: 199 };
        const poolId = chainToPoolId[info.chain.toLowerCase()];
        // 容错：如果找不到 chain ID，默认不处理
        if (!poolId) return;

        const expectedRoom = `kl@${poolId}@${info.contractAddress}@${props.timeframe}`;

        if (update.room === expectedRoom) {
            const newCandle = update.data as CandlestickData<number>;
            
            // 防止 "Cannot update oldest data" 错误
            const currentData = candlestickSeries.data();
            if (currentData.length > 0) {
                const lastCandle = currentData[currentData.length - 1] as CandlestickData<number>;
                if (newCandle.time < lastCandle.time) {
                    log(`⚠️ Dropped late packet. Last: ${lastCandle.time}, New: ${newCandle.time}`);
                    return;
                }
            }
            candlestickSeries.update(newCandle);
            log(`⚡ Realtime update received: ${newCandle.close}`);
        }
    };

    // 👻 生成隐形数据：关键在于“撑开”时间轴，并与 Timeframe 对齐
    const generateGhostData = (timeframe: string) => {
        const intervalSec = getIntervalSeconds(timeframe);
        // 核心：向下取整对齐，确保 9 个图表的 Ghost K 线时间戳完全一致
        // 这样所有图表的 Logical Index 0 都对应着同一个“当前时间”
        const nowAligned = Math.floor(Date.now() / 1000 / intervalSec) * intervalSec;
        
        const data = [];
        for (let i = FORCE_GHOST_CANDLE_COUNT; i >= 0; i--) {
            data.push({
                time: (nowAligned - (i * intervalSec)) as Time,
                value: 0 
            });
        }
        log(`👻 Generated ${data.length} ghost candles ending at ${nowAligned}`);
        return data;
    };

    // 主副作用：图表创建与数据订阅
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

        try {
            log('Creating new LWC instance...');
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
                    shiftVisibleRangeOnNewBar: true, 
                    fixLeftEdge: false, // 允许向左无限拖动
                    fixRightEdge: false, // 允许拖动离开右边缘（查看未来）
                },
                rightPriceScale: { visible: !!props.showAxes, borderColor: '#cccccc', autoScale: true },
                // 👻 左侧隐藏轴给 Ghost Series 使用
                leftPriceScale: { visible: false, autoScale: false }, 
                handleScroll: true, 
                handleScale: true,
            });

            // 1. 添加 Ghost Series (隐形骨架)
            ghostSeries = chart.addSeries(LineSeries, {
                color: 'rgba(0,0,0,0)', 
                lineWidth: 1,
                priceScaleId: 'left',   
                crosshairMarkerVisible: false,
                lastValueVisible: false,
                priceLineVisible: false,
            });
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
                priceScaleId: 'right'
            });

        } catch (e) {
            console.error(`[Chart:${info.symbol}] ❌ Fatal Error creating chart:`, e);
            setStatus(`Chart Error`);
            return;
        }

        // [SENDER] ✨✨✨ 核心修改：发送 Logical Range（逻辑索引）而非 TimeRange ✨✨✨
        // 监听逻辑索引变化，这代表了用户拖动或缩放了网格，而不只是时间
        chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
            // 如果这是由于代码设置范围引起的变化，则忽略，防止死循环
            if (isProgrammaticUpdate) return;

            const myId = getMyId().toLowerCase();
            const activeId = props.activeChartId?.toLowerCase();

            // 只有“当前激活”的图表才有资格指挥其他图表
            if (myId === activeId) {
                if (!isSyncPending) {
                    isSyncPending = true;
                    requestAnimationFrame(() => {
                        // 获取逻辑索引范围 (e.g. from: -5.5, to: 50.2)
                        const logicalRange = chart?.timeScale().getVisibleLogicalRange();
                        if (logicalRange && props.onViewportChange) {
                            props.onViewportChange({ 
                                from: logicalRange.from, 
                                to: logicalRange.to 
                            });
                        }
                        isSyncPending = false;
                    });
                }
            }
        });

        const payload = { address: info.contractAddress, chain: info.chain, interval: timeframe };

        // 数据处理通用逻辑
        const processData = (data: any[], isInitial: boolean) => {
            try {
                const sortedData = data
                    .map(d => ({ ...d, time: Number(d.time) }))
                    .sort((a, b) => a.time - b.time);

                if (isInitial) {
                    log(`📥 Initial historical data loaded: ${sortedData.length} candles`);
                    candlestickSeries?.setData(sortedData as CandlestickData<number>[]);
                    
                    // 初始加载时的视口处理
                    if (props.viewportState) {
                        // [Sync] 如果父级有同步状态，使用 setVisibleLogicalRange 强制对齐逻辑索引
                         chart?.timeScale().setVisibleLogicalRange({
                            from: props.viewportState.from,
                            to: props.viewportState.to
                        });
                    } else {
                        // 否则滚动到最新
                        chart?.timeScale().scrollToRealTime();
                    }
                } else {
                    // 处理分页加载或补充数据
                    const currentData = (candlestickSeries?.data() as CandlestickData<number>[] || []);
                    const newDataMap = new Map(currentData.map(d => [d.time, d]));
                    sortedData.forEach(d => newDataMap.set(d.time as number, d as CandlestickData<number>));
                    const merged = Array.from(newDataMap.values()).sort((a, b) => (a.time as number) - (b.time as number));
                    candlestickSeries?.setData(merged);
                }
                setStatus(`Live`);
            } catch (e) {
                console.error(`[Chart:${info.symbol}] ❌ Failed to process data:`, e);
            }
        };

        const handleInitialData = (response: any) => {
            if (response.interval !== timeframe || response.address.toLowerCase() !== info.contractAddress.toLowerCase()) return;
            if (response.data && response.data.length > 0) {
                processData(response.data, true);
            } else {
                setStatus(`No Data`);
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
                log(`❌ Fetch error: ${err.error}`);
                setStatus(`Error`);
             }
        };

        socket.on('historical_kline_initial', handleInitialData);
        socket.on('historical_kline_completed', handleCompletedData);
        socket.on('kline_fetch_error', handleFetchError);
        socket.on('kline_update', handleKlineUpdate);

        log(`🚀 Requesting historical data...`);
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

    // [RECEIVER] ✨✨✨ 核心修改：接收逻辑索引同步 ✨✨✨
    createEffect(() => {
        const vs = props.viewportState;
        if (!chart || !vs || !props.tokenInfo) return;

        const myId = getMyId().toLowerCase();
        const activeId = props.activeChartId?.toLowerCase();

        // 🚫 如果我是触发源，绝对不要响应，避免回环
        if (myId === activeId) return;

        isProgrammaticUpdate = true;
        try {
            // log(`📥 Syncing viewport to: ${vs.from} - ${vs.to}`);
            // 使用 setVisibleLogicalRange 强制所有图表对齐到相同的“格子数”
            // 配合 Ghost Series，无论数据多少，网格的几何形状（Bar Spacing）都将严格一致
            chart.timeScale().setVisibleLogicalRange({
                from: vs.from,
                to: vs.to
            });
        } catch (e) {
            // LWC 在数据未加载完全时设置 Range 可能会抛错，即使有 Ghost Series
            // 这里的 try-catch 是最后的防线，防止 JS 错误导致组件崩溃
            // console.warn(`[Chart:${props.tokenInfo.symbol}] Sync failed (likely transient):`, e);
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
            // 鼠标进入时，标记此图表为“主动方”，它将拥有广播权限
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