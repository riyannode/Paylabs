// Circle Gateway facilitator client
// Submits signed EIP-3009 TransferWithAuthorization for batch settlement

const GATEWAY_FACILITATOR_URL_TESTNET = "https://gateway-api-testnet.circle.com/v1";
const GATEWAY_FACILITATOR_URL_MAINNET = "https://gateway-api.circle.com/v1";

function getFacilitatorUrl(): string {
  return process.env.CIRCLE_GATEWAY_TESTNET !== "false"
    ? GATEWAY_FACILITATOR_URL_TESTNET
    : GATEWAY_FACILITATOR_URL_MAINNET;
}

export interface GatewaySettlementResult {
  accepted: boolean;
  settlementRef?: string;
  batchId?: string;
  batchPosition?: number;
  error?: string;
}

/**
 * Submit a signed TransferWithAuthorization to Circle Gateway for settlement.
 * Gateway batches the payment and settles onchain.
 *
 * @param signedAuthorization - The full signed authorization from the client wallet
 * @param amountBaseUnits - Amount in USDC base units (6 decimals)
 * @param receiverAddress - Where the payment goes
 */
export async function submitToGateway(
  signedAuthorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
    signature: string;
  },
  amountBaseUnits: string,
  receiverAddress: string
): Promise<GatewaySettlementResult> {
  const facilitatorUrl = getFacilitatorUrl();
  const apiKey = process.env.CIRCLE_GATEWAY_API_KEY;

  // Gateway settlement request
  const body = {
    chainId: 5042002, // Arc testnet
    tokenAddress: "0x3600000000000000000000000000000000000000", // USDC
    amount: amountBaseUnits,
    from: signedAuthorization.from,
    to: receiverAddress,
    transferWithAuthorization: {
      value: signedAuthorization.value,
      validAfter: signedAuthorization.validAfter,
      validBefore: signedAuthorization.validBefore,
      nonce: signedAuthorization.nonce,
      signature: signedAuthorization.signature,
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(`${facilitatorUrl}/transfers`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      return {
        accepted: false,
        error: `Gateway ${res.status}: ${text}`,
      };
    }

    const data = (await res.json()) as Record<string, unknown>;
    return {
      accepted: true,
      settlementRef: (data.id || data.transferId || data.settlementRef) as string | undefined,
      batchId: data.batchId as string | undefined,
      batchPosition: data.batchPosition as number | undefined,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      accepted: false,
      error: `Gateway submission failed: ${msg}`,
    };
  }
}
