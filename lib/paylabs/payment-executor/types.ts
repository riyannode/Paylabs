/**
 * PayLabs Backend Payment Executor — Types
 *
 * Types for the backend payment executor HTTP API.
 * The executor handles Circle DCW signing and Circle Gateway x402 settlement.
 * PayLabs never calls Circle directly — all payment execution goes through the executor.
 */

export interface PaymentExecutorHealthResponse {
  ok: boolean;
  service: string;
  time: string;
  version?: string;
}

export interface PaymentExecutorX402Quote {
  resourceUrl: string;
  amountUsdc: string;
  network: string;
  receiver: string;
  token: string;
  chainId: number;
  challenge: Record<string, unknown>;
}

export interface PaymentExecutorX402PayResult {
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

export interface PaymentExecutorReceipt {
  paymentId: string;
  status: string;
  amountUsdc: string;
  settlementRef?: string;
  txHash?: string;
  explorerUrl?: string;
}

export class PaymentExecutorError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PaymentExecutorError";
    this.status = status;
  }
}
