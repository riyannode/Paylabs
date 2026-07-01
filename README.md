# PayLabs

AI search where every action is budgeted, paid via x402 on Arc/Circle, and receipt-backed.

Users ask a question, set a USDC budget, connect a wallet, sign one x402 entry payment, and get an AI answer with source context, creator payouts, and a receipt.

**Production:** `paylabs-v6.vercel.app`

## How It Works

```
User asks question → Brain plans tier + services → Quote engine prices the run
→ User signs x402 entry payment → Agent runtime executes paid services
→ Sources discovered, creators paid, receipt generated
```

Three layers separate concerns:

| Layer | Role |
|-------|------|
| **Brain** | Plans the run — selects tier, macro nodes, services |
| **Quote Engine** | Prices the run — deterministic, no LLM-generated prices |
| **x402 Gateway** | Settles payments — user entry + internal agent edges |

## Pages

| Route | What it does |
|-------|-------------|
| `/` | Chat interface — ask a question, connect wallet, run search |
| `/explorer` | Payment dashboard — KPIs, x402 service payments, creator payouts, treasury |
| `/receipts` | Receipt history — per-run breakdown with creators, sources, batch status |
| `/source` | Feed items catalog — RSSHub sources with citation/unlock pricing |
| `/creator-dashboard` | Creator onboarding — wallet + profile management |
| `/creator-profile` | Creator claims — register source URLs, verify ownership, monetize |
| `/creator-proof/[claimId]/[nonce]` | Public verification page — shows verified creator badge |

## Route Tiers

| Tier | Macro Nodes | Services |
|------|------------|----------|
| **Easy** | discovery_planner | intent_planner, query_builder, signal_scout_basics |
| **Normal** | discovery_planner, payment_decision | + intent_matcher, source_verifier, value_allocator, trust_verifier, payment_decider |
| **Advanced** | discovery_planner, payment_decision, settlement_memory | + creator_attribution, advanced_evidence_evaluator, creator_payout_router |

Auto-tier: Brain selects optimal tier via a two-step preflight (route-preflight → execute-locked).

## Wallets

**UCW (User-Controlled Wallet)** — production default. Social login, email OTP, PIN flow. User signs x402 entry payments. Circle W3S Web SDK in browser.

**DCW (Developer-Controlled Wallet)** — server-side alternative. Google OAuth + email OTP + passkey auth. Wallet created via Circle DCW SDK. Paid runs execute synchronously in-request.

## Auth

| Method | How |
|--------|-----|
| Google OAuth | ID token verified against `NEXT_PUBLIC_GOOGLE_CLIENT_ID` |
| Email OTP | 6-digit code, SHA-256 hashed, 5min TTL, 5 max attempts |
| WebAuthn Passkey | SimpleWebAuthn, credential stored in `paylabs_dcw_wallets` |

Sessions: JWT via `jose` (Edge-compatible), 7-day httpOnly cookie.

## Creator System

Creators register source URLs (GitHub repos, domains, platform profiles) and verify ownership via:

- `well_known_json` — `.well-known/paylabs-verify.json` on their domain
- `github_repo_file` — `paylabs.json` in repo root
- `hosted_link_backlink` — public bio/README link back to PayLabs
- `manual_review` — manual approval fallback

When a discovery run uses a creator's source, the creator gets paid:

```
Per creator slot: 17 atomic (creator) / 2 atomic (bot) / 1 atomic (service)
= 0.000020 USDC per slot
```

Payout ledger uses claim-before-transfer idempotency — unique constraint on `(run_id, payout_type, subject_id)` prevents double-pay.

## Payment Flow

```
1. User submits prompt + budget
2. Backend creates deterministic quote
3. Backend returns HTTP 402
4. User signs x402 payload (UCW or DCW)
5. Backend verifies + settles via Circle Gateway
6. Brain runtime starts
7. Agent wallets pay macro nodes + child services
8. Creator payouts execute (85/10/5 split)
9. Receipt written
```

## Tech Stack

- Next.js 15, React 19, TypeScript
- Supabase (Postgres, RLS)
- LangChain / LangGraph (agent runtime)
- Circle (UCW, DCW, Gateway, x402 batching)
- Arc Testnet (chain ID 5042002)
- RSSHub (source discovery)
- viem (EVM), Resend (email), SimpleWebAuthn (passkeys)

## Environment

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# Arc
NEXT_PUBLIC_ARC_CHAIN_ID
NEXT_PUBLIC_ARC_RPC_URL
NEXT_PUBLIC_ARC_EXPLORER_URL
NEXT_PUBLIC_ARC_USDC_ADDRESS

# Circle
CIRCLE_API_KEY
CIRCLE_ENTITY_SECRET
NEXT_PUBLIC_CIRCLE_APP_ID
NEXT_PUBLIC_GOOGLE_CLIENT_ID

# Gateway / x402
X402_GATEWAY_ENABLED
X402_GATEWAY_NETWORK
CIRCLE_GATEWAY_API_KEY

# Runtime
PAYLABS_DELEGATED_RUNTIME_ENABLED
PAYLABS_DELEGATED_INLINE_EXECUTION
PAYLABS_AGENT_NANOPAYMENTS_ENABLED
PAYLABS_BRAIN_X402_ENABLED
PAYLABS_NODE_X402_ENABLED
PAYLABS_AUTO_TIER_PREFLIGHT_ENABLED
PAYLABS_APP_URL

# Agent wallets (buyer/seller pairs)
PAYLABS_CONTROLLER_BUYER_WALLET_ID
PAYLABS_BRAIN_BUYER_WALLET_ID
PAYLABS_BRAIN_SELLER_WALLET_ADDRESS
PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID
PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS
PAYLABS_NODE_PAYMENT_DECISION_BUYER_WALLET_ID
PAYLABS_NODE_PAYMENT_DECISION_SELLER_WALLET_ADDRESS
PAYLABS_NODE_SETTLEMENT_MEMORY_BUYER_WALLET_ID
PAYLABS_NODE_SETTLEMENT_MEMORY_SELLER_WALLET_ADDRESS

# Auth
DCW_SESSION_SECRET
RESEND_API_KEY

# RSSHub
PAYLABS_RSSHUB_ENABLED
PAYLABS_RSSHUB_SYNC_SECRET
PAYLABS_RSSHUB_ADMIN_SECRET
PAYLABS_RSSHUB_DEFAULT_BASE_URL

# LLM
PAYLABS_LLM_REQUIRED
PAYLABS_LLM_PROVIDER_DEFAULT
PAYLABS_LLM_BASE_URL_DEFAULT
PAYLABS_LLM_API_KEY_DEFAULT
PAYLABS_TUTOR_MODEL_DEFAULT
```

## Development

```bash
pnpm install
pnpm dev          # localhost:3000
pnpm typecheck    # tsc --noEmit
```

## Security

- No local private keys for production execution
- UCW tokens stay server-side, frontend only keeps wallet address/ID
- Raw x402 payloads, signatures, Gateway responses never stored in receipts
- Budget validation before payment, payer mismatch fails closed
- Settlement mode is not user-selectable
- Raw chain-of-thought never exposed
