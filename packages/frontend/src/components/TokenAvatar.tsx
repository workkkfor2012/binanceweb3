import { Component, createSignal, Show, JSX } from 'solid-js';

export interface TokenAvatarProps {
    symbol: string;
    src?: string | null;
    size?: number; // default: 24
    class?: string;
    style?: JSX.CSSProperties;
    onClick?: (e: MouseEvent) => void;
}

// A vibrant, premium palette (Material Design 500/600 + custom tweaks)
const AVATAR_COLORS = [
    '#EF4444', // Red 500
    '#F97316', // Orange 500
    '#F59E0B', // Amber 500
    '#84CC16', // Lime 500
    '#10B981', // Emerald 500
    '#06B6D4', // Cyan 500
    '#3B82F6', // Blue 500
    '#6366F1', // Indigo 500
    '#8B5CF6', // Violet 500
    '#D946EF', // Fuchsia 500
    '#F43F5E', // Rose 500
    '#0EA5E9', // Sky 500
];

const getSymbolColor = (symbol: string): string => {
    if (!symbol) return AVATAR_COLORS[0];
    let hash = 0;
    for (let i = 0; i < symbol.length; i++) {
        hash = symbol.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % AVATAR_COLORS.length;
    return AVATAR_COLORS[index];
};

const getSymbolData = (symbol: string) => {
    if (!symbol) return '?';
    // Take first char, or first 2 if it's very short? Usually just 1 is best for icons.
    return symbol.charAt(0).toUpperCase();
};

const TokenAvatar: Component<TokenAvatarProps> = (props) => {
    const [imgError, setImgError] = createSignal(false);
    const size = () => props.size || 24;

    // Reset error state if src changes (in case of list recycling or prop updates)
    // createEffect is not strictly needed if we just key by src, but a simple signal works fine.
    // However, in Solid, if props.src changes, we want to retry.
    // simpler approach: use the src in the img tag. if it errors, toggle flag.
    // if src prop changes, we should probably reset the flag.
    // actually, simpler:
    // If we have a src AND no error, show generic img.
    // If not, show fallback.

    return (
        <div
            class={`token-avatar ${props.class || ''}`}
            style={{
                width: `${size()}px`,
                height: `${size()}px`,
                "min-width": `${size()}px`, // Prevent shrinking in flex
                "min-height": `${size()}px`,
                "border-radius": "50%",
                overflow: "hidden",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                cursor: props.onClick ? "pointer" : "default",
                ...props.style
            }}
            onClick={props.onClick}
        >
            <Show
                when={props.src && !imgError()}
                fallback={
                    <div
                        style={{
                            width: "100%",
                            height: "100%",
                            background: getSymbolColor(props.symbol),
                            color: "#FFFFFF",
                            "font-weight": "bold",
                            "font-size": `${size() * 0.55}px`, // slightly larger than half
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "center",
                            "user-select": "none",
                            "text-shadow": "0 1px 2px rgba(0,0,0,0.2)"
                        }}
                    >
                        {getSymbolData(props.symbol)}
                    </div>
                }
            >
                <img
                    src={props.src!}
                    alt={props.symbol}
                    style={{
                        width: "100%",
                        height: "100%",
                        "object-fit": "cover"
                    }}
                    onError={(e) => {
                        console.error(`[TokenAvatar Error] Symbol: ${props.symbol} | URL: ${props.src}`);
                        setImgError(true);
                    }}
                />
            </Show>
        </div>
    );
};

export default TokenAvatar;
