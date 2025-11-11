// packages/frontend/src/SingleKlineChart.tsx
import { Component, createSignal, onMount, onCleanup } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries } from 'lightweight-charts';
import KlineBrowserManager, { LightweightChartKline } from './kline-browser-manager';

// --- 默认配置 ---
const DEFAULT_CONTRACT_ADDRESS = '0xea37a8de1de2d9d10772eeb569e28bfa5cb17707';
const DEFAULT_CHAIN = 'bsc';

// 自定义价格格式化函数
const customPriceFormatter = (price: number): string => {
    if (price < 0.0001) return price.toPrecision(4);
    if (price < 1) return price.toFixed(6);
    return price.toFixed(2);
};

const SingleKlineChart: Component = () => {
    const [status, setStatus] = createSignal('Initializing...');
    const [contractAddress, setContractAddress] = createSignal(DEFAULT_CONTRACT_ADDRESS);
    const [chain, setChain] = createSignal(DEFAULT_CHAIN);

    let chartContainer: HTMLDivElement;
    let chart: IChartApi | null = null;
    let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
    let klineManager: KlineBrowserManager | null = null;

    const loadChart = (addr: string, ch: string) => {
        if (klineManager) klineManager.stop();
        if (chart) chart.remove();

        if (!chartContainer) return;

        setStatus(`Loading ${ch}:${addr.substring(0, 6)}...`);

        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: chartContainer.clientHeight,
            layout: {
                background: { type: ColorType.Solid, color: '#ffffff' },
                textColor: '#333',
            },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            timeScale: {
                borderColor: '#cccccc', timeVisible: true, secondsVisible: false,
            },
            priceScale: { borderColor: '#cccccc' },
            rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0.1 } },
        });

        candlestickSeries = chart.addSeries(CandlestickSeries, {
            priceFormat: { type: 'price', precision: 8, minMove: 0.00000001, formatter: customPriceFormatter },
            upColor: '#28a745', downColor: '#dc3545',
            borderDownColor: '#dc3545', borderUpColor: '#28a745',
            wickDownColor: '#dc3545', wickUpColor: '#28a745',
        });

        klineManager = new KlineBrowserManager(addr, ch);

        klineManager.on('data', (initialData: LightweightChartKline[]) => {
            if (candlestickSeries) {
                candlestickSeries.setData(initialData as CandlestickData<number>[]);
                setStatus(`Live: ${ch.toUpperCase()} / ${addr.substring(0, 6)}...`);
                chart?.timeScale().fitContent();
            }
        });

        klineManager.on('update', (updatedCandle: LightweightChartKline) => {
            candlestickSeries?.update(updatedCandle as CandlestickData<number>);
        });

        klineManager.start();
    };

    onMount(() => {
        loadChart(contractAddress(), chain());
        
        const resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === chartContainer) {
                    chart?.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
                }
            }
        });

        resizeObserver.observe(chartContainer);

        onCleanup(() => {
            resizeObserver.disconnect();
            klineManager?.stop();
            chart?.remove();
        });
    });

    return (
        <div class="single-chart-wrapper">
            <div class="controls">
                <input 
                    type="text" 
                    value={contractAddress()} 
                    onInput={(e) => setContractAddress(e.currentTarget.value)}
                    placeholder="Contract Address"
                />
                <select value={chain()} onChange={(e) => setChain(e.currentTarget.value)}>
                    <option value="bsc">BSC</option>
                    <option value="base">Base</option>
                    <option value="solana">Solana</option>
                </select>
                <button onClick={() => loadChart(contractAddress(), chain())}>Load</button>
            </div>
            <p class="status">{status()}</p>
            <div ref={chartContainer!} class="chart-container" />
        </div>
    );
};

export default SingleKlineChart;