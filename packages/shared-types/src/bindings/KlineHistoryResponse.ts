import type { KlineTick } from "./KlineTick";
import type { LiquidityPoint } from "./LiquidityPoint";

export interface KlineHistoryResponse {
    address: string;
    chain: string;
    interval: string;
    data: Array<KlineTick>;
    liquidityHistory?: Array<LiquidityPoint>;
}
