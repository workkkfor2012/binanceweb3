// packages/shared-types/src/meme-rush.ts

/**
 * 原始 Meme Rush 列表项数据结构
 * 基于浏览器端 RAW_DUMP 解析
 */
export interface MemeRushRawItem {
    /** 
     * 首次被抓取/发现的时间戳 (毫秒)
     * @example 1763999304370 
     */
    firstSeen: number;

    /** 
     * 链 ID (字符串格式)
     * @example "56" (BSC)
     */
    chainId: string;

    /** 
     * 代币合约地址 
     * @example "0x7ea8d425dd41a49a44a218d102678b9760d04444"
     */
    contractAddress: string;

    /** 
     * 代币符号/代码 
     * @example "鸡蛙"
     */
    symbol: string;

    /** 
     * 代币全名 
     * @example "鸡蛙"
     */
    name: string;

    /** 
     * 代币图标 URL 
     * @example "https://static.four.meme/..."
     */
    icon: string;

    /** 
     * 合约图标? (通常为 null)
     */
    caIcon: string | null;

    /** 
     * 图标状态码 (内部逻辑，可能表示审核状态)
     * @example 2
     */
    iconStatus: number;

    /** 
     * CA 图标状态码
     * @example 1
     */
    caIconStatus: number;

    /** 
     * 代币创建时间戳 (毫秒)
     * @example 1763999240000
     */
    createTime: number;

    /** 
     * 区块高度 (创建时或最后更新时) 
     * @example 69330506
     */
    height: number;

    /** 
     * 推特链接
     * @example "https://x.com/..."
     */
    twitter: string | null;

    /** 
     * 官网链接 
     */
    website: string | null;

    /** 
     * Telegram 链接 
     */
    telegram: string | null;

    /** 
     * 绑定曲线进度 (0.00 - 100.00)
     * Meme 盘最重要的指标之一，达到 100% 通常意味着发射到 DEX
     * @example 8.29
     */
    progress: number;

    /** 
     * 协议版本/ID (内部枚举)
     * @example 2001
     */
    protocol: number;

    /** 
     * 持有人数量
     * @example 2
     */
    holders: number;

    /** 
     * 当前流动性 (通常以 USD 计)
     * @example 686.27
     */
    liquidity: number;

    /** 
     * 交易量 (24h 或 总量)
     * @example 343.12
     */
    volume: number;

    /** 
     * 市值 (Market Cap)
     * @example 5502.79
     */
    marketCap: number;

    /** 
     * 总交易次数 (Tx Count)
     * @example 2
     */
    count: number;

    /** 
     * 买入次数
     * @example 2
     */
    countBuy: number;

    /** 
     * 卖出次数
     * @example 0
     */
    countSell: number;

    /** 
     * 前10名持仓占比 (%)
     * 侧面反映筹码集中度，过高可能有砸盘风险
     * @example 6
     */
    holdersTop10Percent: number;

    /** 
     * 开发者持仓占比 (%)
     * @example 6 (可能为 null)
     */
    holdersDevPercent: number | null;

    /** 
     * 狙击手(Sniper)持仓占比 (%)
     * 链上分析检测到的机器人持仓
     * @example 6
     */
    holdersSniperPercent: number;

    /** 
     * 内幕人士(Insider)持仓占比 (%)
     * 也就是通常说的 "老鼠仓"
     * @example 0 (可能为 null)
     */
    holdersInsiderPercent: number | null;

    /** 
     * 开发者已卖出比例 (%)
     * 100 表示跑路或清仓
     * @example 0 (可能为 null)
     */
    devSellPercent: number | null;

    /** 
     * 是否已迁移 (发射到 DEX)
     * @example false
     */
    migrateStatus: boolean;

    /** 
     * 迁移时间戳
     * @example 0
     */
    migrateTime: number;

    /** 
     * 是否在 DexScreener 上付费推广
     * @example false
     */
    paidOnDexScreener: boolean;

    /** 
     * 开发者历史发射/迁移过的代币数量
     * 用于判断是否是"惯犯"或"金狗"开发者
     * @example 3
     */
    devMigrateCount: number;

    /** 
     * 精度 (字符串格式)
     * @example "18"
     */
    decimal: string;

    /** 
     * 敏感代币标记 (可能涉及色情、暴力或诈骗)
     * @example false
     */
    sensitiveToken: boolean;

    /** 
     * 独家代币标记
     * @example false
     */
    exclusive: boolean;
}