export interface RunnerHealthResponse {
  ok: boolean;
  service: string;
  time: string;
  version?: string;
}

export interface RunnerX402Quote {
  resourceUrl: string;
  amountUsdc: string;
  network: string;
  receiver: string;
  token: string;
  chainId: number;
  challenge: Record<string, unknown>;
}

export interface RunnerX402PayInput {
  userWallet: string;
  lessonId: string;
  resourceUrl: string;
  amountUsdc: string;
  creatorWallet: string;
  paymentChallenge: Record<string, unknown>;
  signedAuthorization: Record<string, unknown>;
}

export interface RunnerX402PayResult {
  ok: boolean;
  paymentId?: string;
  authorizationHash?: string;
  paymentRef?: string;
  settlementRef?: string;
  txHash?: string;
  amountUsdc?: string;
  resourceUrl?: string;
  status?: string;
  error?: string;
}

export interface RunnerPaymentReceipt {
  paymentId: string;
  status: string;
  amountUsdc: string;
  settlementRef?: string;
  txHash?: string;
  explorerUrl?: string;
}

export class RunnerError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RunnerError";
    this.status = status;
  }
}
