# PayLabs

PayLabs is an AI search and autonomous x402 payment runtime for Arc.

Users ask a question, set a USDC budget, connect a Circle User-Controlled Wallet, approve one x402 entry payment, and receive an AI answer with source context, payment graph visibility, and a receipt.

The core idea:

> One AI search box. One user budget. One x402 entry payment. A Brain-planned agent runtime where every selected macro node and child service can be paid and recorded.

## What PayLabs Does

PayLabs turns an AI search request into a budgeted, paid, auditable agent run.

A user can:

1. Connect a Circle User-Controlled Wallet.
2. See wallet address, wallet balance, Gateway balance, budget, and planned cost.
3. Deposit USDC into Circle Gateway.
4. Sign one x402 entry payment.
5. Run a Brain-planned source discovery workflow.
6. See source context, payment graph status, tx metadata, and receipt status.

PayLabs separates planning, pricing, signing, settlement, and visibility.

```txt
Brain         = plans the run
Quote Engine  = prices the run
User Wallet   = signs entry payment
Agent Wallets = pay macro nodes and child services
Gateway       = settles x402 payments
Receipts      = prove what happened
```

## How PayLabs Works

```txt
USER
  |
  | prompt + max budget
  v
PAYLABS UI
  |
  | Circle UCW wallet signs entry payment
  v
x402 ENTRY GATE
  |
  | verify payer == user wallet
  | settle entry payment
  v
QUOTE ENGINE
  |
  | deterministic planned max cost
  | fail closed if planned cost > user budget
  v
BRAIN
  |
  | plans strategy
  | selects macro nodes
  | selects child services
  v
AGENT RUNTIME
  |
  | executes paid service graph
  v
SOURCE CONTEXT + RECEIPT
```

The Brain plans the run, but it does not decide prices, wallets, payment refs, tx hashes, settlement mode, or budget bypasses.

## x402 Agent Payment Architecture

PayLabs uses x402 for both the user entry payment and internal agent/service payments.

```txt
                         USER WALLET
                      Circle UCW / EOA
                            |
                            | x402 entry payment
                            v
+--------------------------------------------------+
|                 PAYLABS ENTRY GATE               |
|  verify signature · settle · check payer wallet  |
+--------------------------+-----------------------+
                           |
                           v
+--------------------------------------------------+
|                       BRAIN                      |
|        buyer: run_budget_controller wallet       |
|        seller: Brain service wallet              |
+--------------------------+-----------------------+
                           |
              x402 payments to macro nodes
                           |
        +------------------+------------------+
        |                  |                  |
        v                  v                  v
+---------------+  +---------------+  +---------------+
| discovery     |  | payment       |  | settlement    |
| planner       |  | decision      |  | memory        |
| macro node    |  | macro node    |  | macro node    |
+-------+-------+  +-------+-------+  +-------+-------+
        |                  |                  |
        | x402 child edge  | x402 child edge  | x402 child edge
        v                  v                  v
+---------------+  +---------------+  +---------------+
| intent        |  | source        |  | payment       |
| planner       |  | verifier      |  | router        |
| child service |  | child service |  | child service |
| PAID          |  | PAID          |  | PAID          |
+---------------+  +---------------+  +---------------+

Every selected macro node can be paid with brain.
Every selected child service can be paid x402 with macro node.
Every paid edge is written to the payment graph, service payment events, and receipts.
```

## Brain Runtime

The Brain is the planning layer.

The Brain can decide:

* user intent
* discovery strategy
* query variants
* selected macro nodes
* selected child services
* source discovery strategy
* safe progress summaries
* max registry checks
* max source accesses

The Brain cannot decide:

* prices
* wallet addresses
* payment endpoints
* payment references
* tx hashes
* settlement mode
* budget bypasses
* raw payment metadata
* raw chain-of-thought

## Deterministic Quote Engine

PayLabs uses a canonical quote engine as the source of truth for planned cost.

The quote engine computes:

* Brain treasury fee
* macro node fees
* service edge fees
* registry check fees
* source access fees
* expected payment edges
* planned max cost
* remaining planned budget
* budget pass/fail

If planned cost exceeds user budget, the run fails before payment.

```txt
if plannedCostUsdc > userBudgetUsdc:
    reject before x402 payment
else:
    return x402 challenge
```

No LLM-generated prices.

## User Wallet UX

PayLabs uses Circle User-Controlled Wallets for user-facing payments.

Current wallet UX:

* Social login
* Email OTP
* PIN flow
* wallet address display
* wallet balance display
* Circle Gateway balance display
* deposit amount input
* deposit to Gateway
* refresh balance
* run with x402
* copy wallet address
* safe wallet errors

The browser wallet / EOA path exists as a fallback path, not the default production UX.

## Payment Flow

A PayLabs run uses two payment layers.

### 1. User Entry Payment

The user signs one x402 entry payment before the Brain runtime starts.

Flow:

1. User submits prompt and max budget.
2. Backend creates a deterministic quote.
3. Backend returns HTTP 402 with `PAYMENT-REQUIRED`.
4. User signs the x402 payload with Circle UCW.
5. Frontend retries with `PAYMENT-SIGNATURE`.
6. Backend verifies and settles the payment.
7. Backend checks that payer equals the claimed user wallet.
8. Brain runtime starts only after payment is valid.

### 2. Internal Agent Payments

After entry payment is settled, internal agent wallets execute paid service edges.

Examples:

* run budget controller pays Brain
* Brain pays discovery planner
* Brain pays payment decision
* Brain pays settlement memory
* macro nodes pay selected child services

Each paid edge can include:

* buyer
* seller
* amount
* status
* tx hash
* explorer URL
* error summary
* node type

## Route Tiers

PayLabs currently supports three internal run tiers.

```txt
easy
  macro nodes:
    - discovery_planner

  services:
    - intent_planner
    - query_builder
    - signal_scout

normal
  macro nodes:
    - discovery_planner
    - payment_decision

  services:
    - intent_planner
    - query_builder
    - signal_scout
    - intent_matcher
    - source_verifier
    - value_allocator
    - trust_verifier
    - payment_decider

advanced
  macro nodes:
    - discovery_planner
    - payment_decision
    - settlement_memory

  services:
    - intent_planner
    - query_builder
    - signal_scout
    - intent_matcher
    - source_verifier
    - value_allocator
    - trust_verifier
    - payment_decider
    - payment_router
```

The frontend shows `Plan: Auto`.

The backend maps the run into a deterministic quote.

## Source Discovery

PayLabs uses RSSHub as a source discovery bootstrap layer.

RSSHub routes are ingested into normalized feed items. The source resolver returns safe source context for the Brain and final output.

Safe source context may include:

* title
* canonical URL
* summary
* author or publisher
* domain
* published timestamp
* route path
* trust status
* claim status
* relevance rank
* source confidence

Safe source context must not include:

* raw RSS payload
* raw source payload
* creator wallet
* pricing fields
* private metadata
* secrets

## Visibility Layer

PayLabs writes visibility rows after a run.

```txt
paylabs_run_events
  timeline rows for run start, payment edges, completion, and failure

paylabs_service_payment_events
  one row per service payment edge

paylabs_receipts
  one receipt per discovery run
```

Receipt data includes:

* discovery run ID
* user wallet
* selected tier
* planned cost
* actual settled USDC
* remaining budget
* service fees
* payment count
* last tx hash
* safe receipt summary

Visibility must not store:

* raw signatures
* raw x-payment headers
* raw `PAYMENT-SIGNATURE` headers
* raw signed payloads
* raw Gateway responses
* API keys
* wallet secrets
* entity secrets
* raw chain-of-thought

## API Surface

Core run API:

```txt
POST /api/paylabs/discovery-runs/inline
```

Wallet API:

```txt
POST /api/paylabs/wallet/ucw?action=device-token
POST /api/paylabs/wallet/ucw?action=create-user
POST /api/paylabs/wallet/ucw?action=initialize
POST /api/paylabs/wallet/ucw?action=list-wallets
POST /api/paylabs/wallet/ucw?action=balance
POST /api/paylabs/wallet/ucw?action=sign-challenge
POST /api/paylabs/wallet/ucw?action=approve-deposit
POST /api/paylabs/wallet/ucw?action=gateway-balance
POST /api/paylabs/wallet/ucw?action=session-create
POST /api/paylabs/wallet/ucw?action=session-restore
POST /api/paylabs/wallet/ucw?action=session-get-device
POST /api/paylabs/wallet/ucw?action=session-save-device
POST /api/paylabs/wallet/ucw?action=session-save-login
POST /api/paylabs/wallet/ucw?action=session-finalize-wallet
POST /api/paylabs/wallet/ucw?action=session-save-wallet
POST /api/paylabs/wallet/ucw?action=session-balance
POST /api/paylabs/wallet/ucw?action=session-destroy
```

Source APIs:

```txt
POST /api/paylabs/sources/ingest/rsshub
POST /api/paylabs/sources/resolve
```

Run visibility APIs:

```txt
GET /api/paylabs/runs/[runId]/events
GET /api/paylabs/runs/[runId]/receipt
```

Dashboard APIs:

```txt
GET /api/paylabs/dashboard/summary
GET /api/paylabs/dashboard/recent-payments
GET /api/paylabs/dashboard/recent-runs
GET /api/paylabs/dashboard/last-tx
```

## Tech Stack

```txt
Next.js 15
React 19
TypeScript
Supabase
LangChain / LangGraph
Circle User-Controlled Wallets
Circle Developer-Controlled Wallets
Circle Web SDK
Circle Gateway
x402 batching
Arc Testnet
RSSHub
viem
```

## Security Rules

PayLabs follows these rules:

1. No local private keys for production execution.
2. User wallet signing uses Circle User-Controlled Wallets or explicit EOA fallback.
3. Agent and service payments use server-side Circle Developer-Controlled Wallets.
4. Sensitive UCW tokens stay server-side.
5. The frontend must not store userToken, refreshToken, encryptionKey, deviceToken, or deviceEncryptionKey.
6. The frontend only keeps non-sensitive wallet state such as wallet address and wallet ID.
7. Raw x402 payment payloads are not stored in receipts.
8. Raw signatures are not stored in receipts.
9. Raw Gateway responses are not stored in receipts.
10. Secrets are not printed in logs.
11. Raw chain-of-thought is not exposed.
12. Budget validation happens before payment.
13. Payer mismatch fails closed.
14. Planned max cost and actual settled amount are shown separately.
15. Settlement mode is not user-selectable.

## Environment

Required environment groups:

```txt
Supabase
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY

Arc
  NEXT_PUBLIC_ARC_CHAIN_ID
  NEXT_PUBLIC_ARC_RPC_URL
  NEXT_PUBLIC_ARC_EXPLORER_URL
  NEXT_PUBLIC_ARC_USDC_ADDRESS

Circle
  CIRCLE_API_KEY
  CIRCLE_ENTITY_SECRET
  NEXT_PUBLIC_CIRCLE_APP_ID
  NEXT_PUBLIC_GOOGLE_CLIENT_ID

Circle Gateway / x402
  X402_GATEWAY_ENABLED
  X402_GATEWAY_NETWORK
  CIRCLE_GATEWAY_API_KEY

PayLabs runtime
  PAYLABS_DELEGATED_RUNTIME_ENABLED
  PAYLABS_DELEGATED_INLINE_EXECUTION
  PAYLABS_AGENT_NANOPAYMENTS_ENABLED
  PAYLABS_BRAIN_X402_ENABLED
  PAYLABS_NODE_X402_ENABLED
  PAYLABS_APP_URL

Brain and agent wallets
  PAYLABS_CONTROLLER_BUYER_WALLET_ID
  PAYLABS_BRAIN_BUYER_WALLET_ID
  PAYLABS_BRAIN_SELLER_WALLET_ADDRESS
  PAYLABS_NODE_DISCOVERY_PLANNER_BUYER_WALLET_ID
  PAYLABS_NODE_DISCOVERY_PLANNER_SELLER_WALLET_ADDRESS
  PAYLABS_NODE_PAYMENT_DECISION_BUYER_WALLET_ID
  PAYLABS_NODE_PAYMENT_DECISION_SELLER_WALLET_ADDRESS
  PAYLABS_NODE_SETTLEMENT_MEMORY_BUYER_WALLET_ID
  PAYLABS_NODE_SETTLEMENT_MEMORY_SELLER_WALLET_ADDRESS

RSSHub
  PAYLABS_RSSHUB_ENABLED
  PAYLABS_RSSHUB_SYNC_SECRET
  PAYLABS_RSSHUB_ADMIN_SECRET
  PAYLABS_RSSHUB_DEFAULT_BASE_URL

LLM
  PAYLABS_LLM_REQUIRED
  PAYLABS_LLM_PROVIDER_DEFAULT
  PAYLABS_LLM_BASE_URL_DEFAULT
  PAYLABS_LLM_API_KEY_DEFAULT
  PAYLABS_TUTOR_MODEL_DEFAULT
```

## Development

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm build
```

Default dev server:

```txt
http://localhost:3000
```

## Production Validation Checklist

A real PayLabs run should prove:

```txt
[ ] User connects Circle User-Controlled Wallet
[ ] Wallet address appears
[ ] Wallet USDC balance appears
[ ] Gateway balance appears
[ ] User deposits USDC into Gateway
[ ] Backend quote returns planned cost
[ ] User signs x402 entry payment
[ ] Backend verifies payer matches user wallet
[ ] Backend settles entry payment
[ ] Brain runtime starts
[ ] Macro node payment edges execute
[ ] Child service payment edges execute
[ ] tx hash / explorer URL is visible
[ ] receipt_ready is true
[ ] run events are readable
[ ] receipt endpoint returns planned vs actual settled
```

## Project Goal

PayLabs aims to become an AI search interface where every paid action is budgeted, user-approved, Brain-planned, source-aware, and receipt-backed.

The user should know:

```txt
what they asked
what the Brain planned
how much it could cost
which agents/services were paid
which sources were used
what actually settled
where the receipt is
```
