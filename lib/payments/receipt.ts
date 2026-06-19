// Revenue split constants (basis points)
export const PAYLABS_CREATOR_BPS = 8500;  // 85%
export const PAYLABS_PLATFORM_BPS = 1000; // 10%
export const PAYLABS_TREASURY_BPS = 500;  // 5%

export function computeSplit(grossAmountUsdc: number) {
  return {
    creator: (grossAmountUsdc * PAYLABS_CREATOR_BPS) / 10000,
    platform: (grossAmountUsdc * PAYLABS_PLATFORM_BPS) / 10000,
    treasury: (grossAmountUsdc * PAYLABS_TREASURY_BPS) / 10000,
  };
}
