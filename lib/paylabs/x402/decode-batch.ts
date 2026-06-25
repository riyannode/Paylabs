/**
 * submitBatch calldata decoder
 *
 * Decodes the inner `calldataBytes` of a `submitBatch(bytes,bytes)` tx
 * to extract batch entries (address + delta) and net transfers.
 *
 * Used to verify buyer/seller from a settlement UUID actually appears
 * in the on-chain batch, matching Canteen's decode-batch.ts logic.
 *
 * Layout of inner calldataBytes (per on-chain inspection):
 *   word 0: offset pointer to entries (typically 0xa0 = 160)
 *   word 1: batchId (bytes32)
 *   word 2: gateway domain (uint32, last byte populated)
 *   word 3: token address
 *   word 4: gateway-wallet contract address
 *   word 5: entries length
 *   words 6+: (address, int256 delta) pairs
 */

import {
  createPublicClient,
  http,
  decodeFunctionData,
  parseAbi,
  hexToBigInt,
  getAddress,
  type Hex,
  type PublicClient,
} from "viem";

const ARC_RPC =
  process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.network";

const SUBMIT_BATCH_ABI = parseAbi([
  "function submitBatch(bytes calldataBytes, bytes signature)",
]);

export type BatchEntry = {
  address: `0x${string}`;
  delta: bigint;
  /** Human-readable USDC amount (e.g. "-0.010000") */
  usdc: string;
};

export type NetTransfer = {
  from: `0x${string}`;
  to: `0x${string}`;
  usdc: string;
};

export type DecodedBatch = {
  txHash: `0x${string}`;
  blockNumber: bigint;
  blockTimestamp: number;
  relayer: `0x${string}`;
  contract: `0x${string}`;
  batchId: `0x${string}`;
  domain: number;
  token: `0x${string}`;
  innerContract: `0x${string}`;
  entries: BatchEntry[];
  netTransfers: NetTransfer[];
};

/**
 * Decode a submitBatch tx's calldata to extract entries and net transfers.
 * Returns null if the tx is not a valid submitBatch or decoding fails.
 */
export async function decodeBatchTx(
  txHash: string,
  client?: PublicClient,
): Promise<DecodedBatch | null> {
  try {
    const c =
      client ??
      createPublicClient({
        transport: http(ARC_RPC),
      });

    const tx = await c.getTransaction({ hash: txHash as `0x${string}` });
    if (!tx.to) return null;

    const decoded = decodeFunctionData({
      abi: SUBMIT_BATCH_ABI,
      data: tx.input,
    });
    if (decoded.functionName !== "submitBatch") return null;

    const [calldataBytesHex] = decoded.args;
    const calldata = (calldataBytesHex as Hex).slice(2); // strip 0x

    const word = (i: number) => calldata.slice(i * 64, (i + 1) * 64);
    const addrFromWord = (i: number) =>
      getAddress(("0x" + word(i).slice(24)) as `0x${string}`);
    const intFromWord = (i: number, signed = false) =>
      hexToBigInt(("0x" + word(i)) as Hex, { signed });

    // word 0: offset pointer (skip)
    // word 1: batchId
    const batchId = ("0x" + word(1)) as Hex;
    // word 2: domain
    const domain = Number(intFromWord(2));
    // word 3: token
    const token = addrFromWord(3);
    // word 4: inner contract
    const innerContract = addrFromWord(4);
    // word 5: entries count
    const count = Number(intFromWord(5));

    // words 6+: (address, int256 delta) pairs
    const entries: BatchEntry[] = [];
    for (let i = 0; i < count; i++) {
      const address = addrFromWord(6 + i * 2);
      const delta = intFromWord(7 + i * 2, true); // signed
      entries.push({ address, delta, usdc: formatSignedUsdc(delta) });
    }

    // Net transfers: pair each negative with an exact-opposite positive
    const negatives = entries.filter((e) => e.delta < BigInt(0));
    const positives = [...entries.filter((e) => e.delta > BigInt(0))];
    const netTransfers: NetTransfer[] = [];
    for (const n of negatives) {
      const idx = positives.findIndex((p) => p.delta === -n.delta);
      if (idx >= 0) {
        netTransfers.push({
          from: n.address,
          to: positives[idx].address,
          usdc: formatSignedUsdc(-n.delta),
        });
        positives.splice(idx, 1);
      }
    }

    // Block info
    const blockNumber = tx.blockNumber ?? BigInt(0);
    const block = await c.getBlock({ blockNumber });
    const blockTimestamp = Number(block.timestamp);

    return {
      txHash: txHash as `0x${string}`,
      blockNumber,
      blockTimestamp,
      relayer: tx.from,
      contract: tx.to,
      batchId,
      domain,
      token,
      innerContract,
      entries,
      netTransfers,
    };
  } catch (e) {
    console.error("[decode-batch] decode failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Check if a buyer address appears in the batch entries with a negative delta
 * (meaning they paid into the batch).
 */
export function buyerInBatch(
  decoded: DecodedBatch,
  buyerAddress: string,
): { found: boolean; entry?: BatchEntry } {
  const normalized = buyerAddress.toLowerCase();
  for (const entry of decoded.entries) {
    if (entry.address.toLowerCase() === normalized && entry.delta < BigInt(0)) {
      return { found: true, entry };
    }
  }
  return { found: false };
}

/**
 * Check if a seller/recipient address appears in the batch entries with a
 * positive delta (meaning they received from the batch).
 */
export function sellerInBatch(
  decoded: DecodedBatch,
  sellerAddress: string,
): { found: boolean; entry?: BatchEntry } {
  const normalized = sellerAddress.toLowerCase();
  for (const entry of decoded.entries) {
    if (entry.address.toLowerCase() === normalized && entry.delta > BigInt(0)) {
      return { found: true, entry };
    }
  }
  return { found: false };
}

/**
 * Format a signed bigint delta as human-readable USDC (e.g. "-0.010000").
 */
function formatSignedUsdc(v: bigint): string {
  const sign = v < BigInt(0) ? "-" : "";
  const abs = v < BigInt(0) ? -v : v;
  const whole = abs / BigInt(1000000);
  const frac = (abs % BigInt(1000000)).toString().padStart(6, "0");
  return `${sign}${whole}.${frac}`;
}
