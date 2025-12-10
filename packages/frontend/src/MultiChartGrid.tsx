import { Component, createSignal, onMount, onCleanup, createEffect } from 'solid-js';
import { KlineChartController } from './controllers/KlineChartController';
import type { MarketItem } from 'shared-types';
import type { ViewportState } from './ChartPageLayout';
import type { ChartTheme } from './themes';

const BACKEND_URL = 'https://localhost:3001';

interface MultiChartGridProps {
  tokens: MarketItem[];
  onBlockToken: (contractAddress: string) => void;
  timeframe: string;
  viewportState: ViewportState | null;
  onViewportChange: (state: ViewportState | null) => void;
  activeChartId: string | null;
  onSetActiveChart: (id: string | null) => void;
  theme: ChartTheme;
}

const MultiChartGrid: Component<MultiChartGridProps> = (props) => {
  // 1. Static refs for the 9 slots
  let slots: HTMLDivElement[] = [];
  const controllers: KlineChartController[] = [];

  // 2. State for overlay UI (Legend, Status, Header) that sits ON TOP of the static chart
  const [chartStates, setChartStates] = createSignal<any[]>(Array(9).fill({
    status: 'Initializing',
    legend: null,
    token: null
  }));

  const updateChartState = (index: number, partialState: any) => {
    setChartStates(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...partialState };
      return next;
    });
  };

  onMount(() => {
    // Initialize 9 controllers
    for (let i = 0; i < 9; i++) {
      const container = slots[i];
      if (!container) continue;

      const controller = new KlineChartController({
        container: container,
        theme: props.theme,
        activeChartIdGetter: () => props.activeChartId,
        onStatusChange: (s) => updateChartState(i, { status: s }),
        onLegendChange: (l) => updateChartState(i, { legend: l }),
        onViewportChange: (from, to) => props.onViewportChange({ from, to })
      });
      controllers.push(controller);
    }
  });

  onCleanup(() => {
    controllers.forEach(c => c.destroy());
  });

  // 3. Sync Effect: The core imperative bridge
  createEffect(() => {
    const tokens = props.tokens || [];
    const tf = props.timeframe;

    // Loop through fixed 9 slots
    for (let i = 0; i < 9; i++) {
      const token = tokens[i];
      const controller = controllers[i];

      if (controller) {
        // Sync Controller
        controller.sync(token, tf, i);

        // Update Local UI State
        updateChartState(i, { token: token });
      }
    }
  });

  // Theme Sync
  createEffect(() => {
    const t = props.theme;
    controllers.forEach(c => c.updateTheme(t));
  });

  // Viewport Sync
  createEffect(() => {
    const vs = props.viewportState;
    if (vs) {
      controllers.forEach(c => c.setViewport(vs.from, vs.to));
    }
  });

  return (
    <div
      id="chart-grid-container"
      style={{
        "background-color": props.theme.grid.vertLines,
        "border-color": props.theme.grid.vertLines,
        "display": "grid",
        "grid-template-columns": "repeat(3, 1fr)",
        "grid-template-rows": "repeat(3, 1fr)",
        "gap": "1px", // for grid lines
        "height": "100%",
        "width": "100%"
      }}
    >
      {/* Render 9 static slots */}
      {Array.from({ length: 9 }).map((_, index) => (
        <div class="single-chart-wrapper" style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          background: props.theme.layout.background,
          overflow: 'hidden'
        }}
          onMouseEnter={() => {
            const t = chartStates()[index].token;
            if (t) props.onSetActiveChart(t.contractAddress);
          }}
        >
          {/* Header UI */}
          <div class="chart-header" style={{
            "background-color": props.theme.layout.background,
            "color": props.theme.layout.textColor,
            "border-bottom": `1px solid ${props.theme.grid.horzLines}`,
            "height": "30px", // fixed height
            "display": "flex",
            "align-items": "center",
            "padding": "0 8px",
            "gap": "8px",
            "font-size": "12px"
          }}>
            {(() => {
              const state = chartStates()[index];
              const token = state.token;
              if (!token) return <span class="placeholder">{state.status}</span>;
              return (
                <>
                  {token.icon && (
                    <img
                      src={`${BACKEND_URL}/image-proxy?url=${encodeURIComponent(token.icon)}&symbol=${token.symbol}`}
                      class="icon-small"
                      style={{ width: '16px', height: '16px', borderRadius: '50%' }}
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                    />
                  )}
                  <span class="symbol-title" style={{ fontWeight: 'bold' }}>{token.symbol}</span>
                  <span class="chain-badge" style={{ opacity: 0.7 }}>{token.chain.toUpperCase()}</span>
                  <button
                    class="block-button"
                    onClick={() => props.onBlockToken(token.contractAddress)}
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5 }}
                  >🚫</button>
                </>
              );
            })()}
          </div>

          {/* Legend UI */}
          <div class="chart-legend" style={{
            position: 'absolute', top: '34px', left: '8px', "z-index": 10,
            "font-family": "monospace", "font-size": "10px",
            "pointer-events": "none", color: props.theme.layout.textColor
          }}>
            {(() => {
              const l = chartStates()[index].legend;
              if (!l) return null;
              return (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ "font-weight": "bold" }}>{l.time}</span>
                  <span>O:<span style={{ color: l.color }}>{l.open}</span></span>
                  <span>H:<span style={{ color: l.color }}>{l.high}</span></span>
                  <span>L:<span style={{ color: l.color }}>{l.low}</span></span>
                  <span>C:<span style={{ color: l.color }}>{l.close}</span></span>
                  <span>{l.changePercent}</span>
                </div>
              );
            })()}
          </div>

          {/* The Chart Container - Controlled by Class */}
          <div
            ref={(el) => slots[index] = el}
            class="chart-container"
            style={{ width: '100%', height: 'calc(100% - 30px)' }}
          />
        </div>
      ))}
    </div>
  );
};

export default MultiChartGrid;