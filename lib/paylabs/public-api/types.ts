export type PublicRouteTier = "auto" | "easy" | "normal" | "advanced";
export type PublicResponseMode = "compact" | "full";

export type PublicApiErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_ROUTE_TIER"
  | "BUDGET_EXCEEDED"
  | "PAYMENT_REQUIRED"
  | "INVALID_PAYMENT"
  | "PAYMENT_EXPIRED"
  | "PAYMENT_REPLAYED"
  | "PAYMENT_SETTLEMENT_FAILED"
  | "PREFLIGHT_FAILED"
  | "LOCKED_QUOTE_EXPIRED"
  | "RUN_FAILED"
  | "RUN_NOT_FOUND"
  | "READ_TOKEN_INVALID"
  | "GATEWAY_TEMPORARILY_UNAVAILABLE";

export interface PublicResearchRequest {
  goal: string;
  route_tier?: PublicRouteTier;
  max_budget_usdc?: string | number;
  response_mode?: PublicResponseMode;
  client_request_id?: string;
}

export interface PublicSource {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  published_at: string | null;
}

export interface PublicResearchResult {
  answer: string | null;
  reasoning: {
    summary: string | null;
    route_reason: string | null;
    plan_summary: string | null;
    steps?: string[];
  };
  sources: PublicSource[];
}
