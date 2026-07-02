# PayLabs Codebase Map

> Generated from codebase inspection. Last updated: 2026-07-02

---

## Wallet Boundary (non-negotiable)

### UCW — Creator Wallet Only

- `components/paylabs/UcwConnectModal.tsx`
- `components/paylabs/CreatorWalletPanel.tsx`
- `components/paylabs/useCreatorUcwWallet.ts`
- `app/api/paylabs/wallet/ucw/route.ts`
- `app/creator-profile/**`
- `app/creator-dashboard/**`
- `app/creator-proof/**`

**Role:** Creator onboarding, identity, source claim, source monetization wallet.
**Explicitly not used for x402 chat payments.**

### DCW — PayLabs Payment Wallet

- `components/paylabs/DcwModal.tsx`
- `app/paylabs-chat-client.tsx`
- `app/api/paylabs/auth/**`
- `app/api/paylabs/dcw/**`
- `lib/paylabs/dcw/**`
- `lib/paylabs/x402/dcw-signer-adapter.ts`
- `lib/paylabs/x402/buyer-transport.ts`

**Role:** Chat user wallet, x402 entry payment, Gateway deposit/balance, automated PayLabs chat payment.

### Shared Wallet Types

- `components/paylabs/wallet-types.ts` — `WalletState`, `WalletInfo`, `PayLabsWalletBalance`

---

## Agent Runtime

### Brain Planner (always LLM-assisted)
- `lib/paylabs/langgraph/brain/brain-planner-graph.ts`

### Macro-Node Phases
- `lib/paylabs/langgraph/macro-nodes/discovery-planner-graph.ts` (Phase 1: Easy)
- `lib/paylabs/langgraph/macro-nodes/payment-decision-graph.ts` (Phase 2: Normal+)
- `lib/paylabs/langgraph/macro-nodes/settlement-memory-graph.ts` (Phase 3: Normal+)

### Tier Service Bundles
- **Easy:** `intent_planner` → `query_builder` → `signal_scout_basics`
- **Normal:** above + `intent_matcher` → `source_verifier` → `value_allocator` → `trust_verifier` → `payment_decider` + `creator_attribution` → `creator_payout_router`
- **Advanced:** above + `advanced_evidence_evaluator`

### Quote Engine (single source of truth for pricing)
- `lib/paylabs/delegated-runtime/quote-engine.ts`

---

## API Routes

| Category | Routes |
|---|---|
| Chat/Run execution | `brain/run`, `agent-services/*/run`, `macro-nodes/*/run`, `discovery-runs/*`, `quote`, `runs/*` |
| x402 Payment | `payments/gateway-deposit`, `payments/readiness`, `payments/tx-status/*`, `creator-distribution/payout` |
| Payment visibility | `dashboard/*`, `x402/batch-tx/*`, `x402/settlements/*`, `x402/runs/*/batch-tx`, `receipts` |
| DCW auth/wallet | `auth/google`, `auth/otp/*`, `auth/passkey/*`, `auth/session`, `dcw/*` |
| UCW creator wallet | `wallet/ucw`, `wallet/ucw/health` |
| Creator profile | `creator`, `creator-profile`, `creator-sources`, `creator-verify` |
| RSSHub/source | `rsshub/routes`, `rsshub/sync`, `sources/ingest/rsshub`, `sources/resolve`, `feed-items` |
| Health/debug | `health`, `health/brain-planner`, `debug/brain-plan`, `debug/self-call` |

---

## Database Tables

| Domain | Tables |
|---|---|
| Runs | `paylabs_discovery_runs`, `paylabs_discovery_run_items` |
| Events | `paylabs_run_events` |
| Receipts | `paylabs_receipts`, `paylabs_source_payments` |
| Payment edges | `paylabs_service_payment_events` |
| Payout ledger | `paylabs_payout_ledger`, `paylabs_payout_events` |
| Creator claims | `paylabs_creator_claims`, `paylabs_source_attributions` |
| Feed items | `paylabs_feed_items`, `paylabs_rsshub_routes` |
| Wallet/auth | `paylabs_dcw_wallets`, `ucw_sessions`, `paylabs_webauthn_challenges`, `paylabs_email_otps` |
| Memory | `paylabs_creator_memory`, `paylabs_evaluator_memory` |

---

## Do-Not-Move List

These files are sensitive — moving them risks breaking payment flows, wallet auth, or settlement logic:

- `lib/paylabs/x402/buyer-transport.ts` — Core x402 buyer flow
- `lib/paylabs/x402/seller-challenge.ts` — Core x402 seller challenge + verify/settle
- `lib/paylabs/x402/customer-entry-payment.ts` — Customer entry payment gate
- `lib/paylabs/x402/dcw-signer-adapter.ts` — DCW SDK bridge
- `lib/paylabs/auth/session.ts` — DCW JWT session management
- `lib/paylabs/auth/otp.ts` — OTP generation + hashing
- `lib/paylabs/ucw.ts` — UCW backend API wrappers
- `lib/paylabs/dcw/config.ts` — DCW chain/contract config
- `lib/paylabs/creator-distribution/payout-ledger.ts` — Idempotent payout ledger
- `lib/paylabs/creator-distribution/payout-executor.ts` — Real payout execution
- `lib/paylabs/creator-distribution/transport.ts` — Creator payment transport
- `lib/paylabs/visibility/writer.ts` — Receipt/event writer
- `lib/paylabs/delegated-runtime/orchestrator.ts` — Main orchestrator
- `lib/paylabs/delegated-runtime/locked-orchestration.ts` — Locked orchestration
- `lib/paylabs/delegated-runtime/quote-engine.ts` — Pricing single source of truth
- `app/api/paylabs/dcw/*` — DCW auth/wallet/session routes
- `app/api/paylabs/auth/*` — Auth routes
- `app/api/paylabs/wallet/ucw/*` — UCW wallet routes
- `app/api/paylabs/x402/*` — x402 payment routes
- `app/api/paylabs/discovery-runs/*` — Run execution routes
- `app/api/paylabs/creator-distribution/payout/route.ts` — Payout x402 endpoint

---

## Security Rules

- Never expose raw x-payment headers
- Never expose raw signatures
- Never expose raw Gateway responses
- Never expose private keys, entity secrets, wallet IDs, challenge payloads, user/device tokens
- Public UI can show safe payment transparency only (amounts, tx hashes, explorer URLs)
- `select("*")` is banned for API-facing queries — use explicit field whitelists
