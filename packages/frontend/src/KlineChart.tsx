// packages/frontend/src/KlineChart.tsx
import { Component, createSignal, onMount, onCleanup } from 'solid-js';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickData, CandlestickSeries } from 'lightweight-charts';
import KlineBrowserManager, { LightweightChartKline } from './kline-browser-manager';

// --- 默认配置 ---
const DEFAULT_CONTRACT_ADDRESS = '0xea37a8de1de2d9d10772eeb569e28bfa5cb17707';
const DEFAULT_CHAIN = 'bsc';

// ✨ 新增: 自定义价格格式化函数
const customPriceFormatter = (price: number): string => {
    // 根据价格范围决定小数位数，确保低价品种的精度
    if (price < 0.0001) {
        return price.toPrecision(4); // 使用科学计数法或更多小数位
    }
    if (price < 1) {
        return price.toFixed(6); // 对于小于1的价格，显示6位小数
    }
    return price.toFixed(2); // 对于大于1的价格，显示2位小数
};


const KlineChart: Component = () => {
    const [status, setStatus] = createSignal('Initializing...');
    const [contractAddress, setContractAddress] = createSignal(DEFAULT_CONTRACT_ADDRESS);
    const [chain, setChain] = createSignal(DEFAULT_CHAIN);

    let chartContainer: HTMLDivElement;
    let chart: IChartApi | null = null;
    let candlestickSeries: ISeriesApi<'Candlestick'> | null = null;
    let klineManager: KlineBrowserManager | null = null;

    // ✨ 核心修改 1: 将图表加载逻辑封装成一个函数
    const loadChart = (addr: string, ch: string) => {
        // 停止并清理旧的实例
        if (klineManager) {
            klineManager.stop();
        }
        if (chart) {
            chart.remove();
        }

        setStatus(`正在为 ${ch} 链上的 ${addr.substring(0, 8)}... 加载数据`);

        chart = createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: 600,
            layout: {
                background: { type: ColorType.Solid, color: '#ffffff' },
                textColor: '#333',
            },
            grid: {
                vertLines: { color: '#e1e4e8' },
                horzLines: { color: '#e1e4e8' },
            },
            timeScale: {
                borderColor: '#cccccc',
                timeVisible: true,
                secondsVisible: false,
            },
            // ✨ 核心修改 2: 配置价格轴的格式
            priceScale: {
                borderColor: '#cccccc',
            },
        });

        candlestickSeries = chart.addSeries(CandlestickSeries, {
            // ✨ 核心修改 2: 配置价格系列的格式
            priceFormat: {
                type: 'price',
                precision: 8, // 内部计算精度，设为一个较大的值
                minMove: 0.00000001, // 价格最小变动单位
                formatter: customPriceFormatter, // 使用自定义格式化函数
            },
            upColor: '#28a745',
            downColor: '#dc3545',
            borderDownColor: '#dc3545',
            borderUpColor: '#28a745',
            wickDownColor: '#dc3545',
            wickUpColor: '#28a745',
        });

        klineManager = new KlineBrowserManager(addr, ch);

        klineManager.on('data', (initialData: LightweightChartKline[]) => {
            if (candlestickSeries) {
                candlestickSeries.setData(initialData as CandlestickData<number>[]);
                setStatus(`实时图表: ${addr}`);
                chart?.timeScale().fitContent();
            }
        });

        klineManager.on('update', (updatedCandle: LightweightChartKline) => {
            if (candlestickSeries) {
                candlestickSeries.update(updatedCandle as CandlestickData<number>);
            }
        });

        klineManager.start();
    };

    onMount(() => {
        loadChart(contractAddress(), chain());
        
        const handleResize = () => chart?.applyOptions({ width: chartContainer.clientWidth });
        window.addEventListener('resize', handleResize);

        onCleanup(() => {
            console.log('正在清理图表和数据管理器...');
            klineManager?.stop();
            window.removeEventListener('resize', handleResize);
            chart?.remove();
        });
    });

    return (
        <div class="kline-chart-page">
            <h1>K-Line Chart (Test Page)</h1>
            
            {/* ✨ 核心修改 1: 添加输入框和按钮 */}
            <div class="controls">
                <input 
                    type="text" 
                    value={contractAddress()} 
                    onInput={(e) => setContractAddress(e.currentTarget.value)}
                    placeholder="输入合约地址"
                />
                <select value={chain()} onChange={(e) => setChain(e.currentTarget.value)}>
                    <option value="bsc">BSC</option>
                    <option value="base">Base</option>
                    <option value="solana">Solana</option>
                </select>
                <button onClick={() => loadChart(contractAddress(), chain())}>
                    加载图表
                </button>
            </div>

            <p class="status">{status()}</p>
            <div ref={chartContainer!} class="chart-container" />
        </div>
    );
};

export default KlineChart;