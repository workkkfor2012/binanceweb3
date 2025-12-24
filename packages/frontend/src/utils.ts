export const getIntervalSeconds = (timeframe: string): number => {
    const val = parseInt(timeframe);
    if (timeframe.endsWith('m')) return val * 60;
    if (timeframe.endsWith('h')) return val * 3600;
    if (timeframe.endsWith('d')) return val * 86400;
    return 60; // default 1m
};

export const formatTimeInChina = (timeInSeconds: number): string => {
    try {
        const date = new Date(timeInSeconds * 1000);
        return date.toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch (e) {
        return new Date(timeInSeconds * 1000).toLocaleTimeString();
    }
};

export const formatBigNumber = (num: number): string => {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K';
    return num.toFixed(2);
};

export const customPriceFormatter = (price: number): string => {
    const s = new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 10,
        useGrouping: false
    }).format(price);
    if (s.includes('.')) {
        return s.replace(/\.?0+$/, '');
    }
    return s;
};

export const getAdaptivePriceFormat = (price: number) => {
    if (!price || price <= 0) {
        return { type: 'price' as const, precision: 4, minMove: 0.0001 };
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
        type: 'price' as const,
        precision: finalPrecision,
        minMove: minMove,
    };
};
