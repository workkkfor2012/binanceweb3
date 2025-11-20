// packages/frontend/src/themes.ts
export interface ChartTheme {
    name: string;
    layout: {
        background: string;
        textColor: string;
    };
    grid: {
        vertLines: string;
        horzLines: string;
    };
    candle: {
        upColor: string;
        downColor: string;
        borderUpColor: string;
        borderDownColor: string;
        wickUpColor: string;
        wickDownColor: string;
    };
}

export const PRESET_THEMES: ChartTheme[] = [
    {
        name: 'Classic Light',
        layout: { background: '#ffffff', textColor: '#333333' },
        grid: { vertLines: '#f0f3fa', horzLines: '#f0f3fa' },
        candle: {
            upColor: '#28a745', downColor: '#dc3545',
            borderUpColor: '#28a745', borderDownColor: '#dc3545',
            wickUpColor: '#28a745', wickDownColor: '#dc3545'
        }
    },
    {
        name: 'Classic Dark',
        layout: { background: '#131722', textColor: '#d1d4dc' },
        grid: { vertLines: '#242733', horzLines: '#242733' },
        candle: {
            upColor: '#26a69a', downColor: '#ef5350',
            borderUpColor: '#26a69a', borderDownColor: '#ef5350',
            wickUpColor: '#26a69a', wickDownColor: '#ef5350'
        }
    },
    {
        name: 'Binance Original',
        layout: { background: '#1e1e1e', textColor: '#76808F' },
        grid: { vertLines: '#2a2a2a', horzLines: '#2a2a2a' },
        candle: {
            upColor: '#0ECB81', downColor: '#F6465D',
            borderUpColor: '#0ECB81', borderDownColor: '#F6465D',
            wickUpColor: '#0ECB81', wickDownColor: '#F6465D'
        }
    },
    {
        name: 'TradingView Blue',
        layout: { background: '#ffffff', textColor: '#131722' },
        grid: { vertLines: '#E6E6E6', horzLines: '#E6E6E6' },
        candle: {
            upColor: '#2962FF', downColor: '#F23645',
            borderUpColor: '#2962FF', borderDownColor: '#F23645',
            wickUpColor: '#2962FF', wickDownColor: '#F23645'
        }
    },
    {
        name: 'Midnight Purple',
        layout: { background: '#191026', textColor: '#bfa3d9' },
        grid: { vertLines: '#301e4d', horzLines: '#301e4d' },
        candle: {
            upColor: '#9c27b0', downColor: '#ff9800',
            borderUpColor: '#9c27b0', borderDownColor: '#ff9800',
            wickUpColor: '#9c27b0', wickDownColor: '#ff9800'
        }
    },
    {
        name: 'Terminal Green',
        layout: { background: '#000000', textColor: '#00ff00' },
        grid: { vertLines: '#0f330f', horzLines: '#0f330f' },
        candle: {
            upColor: '#00ff00', downColor: '#003300',
            borderUpColor: '#00ff00', borderDownColor: '#00ff00',
            wickUpColor: '#00ff00', wickDownColor: '#00ff00'
        }
    },
    {
        name: 'Solarized Light',
        layout: { background: '#fdf6e3', textColor: '#657b83' },
        grid: { vertLines: '#eee8d5', horzLines: '#eee8d5' },
        candle: {
            upColor: '#859900', downColor: '#dc322f',
            borderUpColor: '#859900', borderDownColor: '#dc322f',
            wickUpColor: '#859900', wickDownColor: '#dc322f'
        }
    },
    {
        name: 'Monochrome',
        layout: { background: '#ffffff', textColor: '#000000' },
        grid: { vertLines: '#f0f0f0', horzLines: '#f0f0f0' },
        candle: {
            upColor: '#ffffff', downColor: '#000000',
            borderUpColor: '#000000', borderDownColor: '#000000',
            wickUpColor: '#000000', wickDownColor: '#000000'
        }
    },
    {
        name: 'Ocean Breeze',
        layout: { background: '#0f172a', textColor: '#94a3b8' },
        grid: { vertLines: '#1e293b', horzLines: '#1e293b' },
        candle: {
            upColor: '#38bdf8', downColor: '#f472b6',
            borderUpColor: '#38bdf8', borderDownColor: '#f472b6',
            wickUpColor: '#38bdf8', wickDownColor: '#f472b6'
        }
    },
    {
        name: 'Cyberpunk',
        layout: { background: '#050505', textColor: '#00ffff' },
        grid: { vertLines: '#1a1a1a', horzLines: '#1a1a1a' },
        candle: {
            upColor: '#00e5ff', downColor: '#ff0055',
            borderUpColor: '#00e5ff', borderDownColor: '#ff0055',
            wickUpColor: '#00e5ff', wickDownColor: '#ff0055'
        }
    }
];