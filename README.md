# PayLabs

AI search + creator monetization platform. Every search is budgeted, every source is paid, every creator gets their share.

Users ask a question, set a USDC budget, connect a wallet, sign one x402 entry payment, and get an AI answer — where the creators behind the sources used in that answer automatically receive USDC payouts.

**Production:** `paylabs-v6.vercel.app`

## What PayLabs Does

**For users:** AI-powered source discovery. Ask a question, get answers backed by real sources from across the web, with full transparency on what was searched, which sources were used, and what it cost.

**For creators:** Automatic monetization. Register your GitHub repos, blogs, or domains as sources. When PayLabs uses your content in an answer, you get paid in USDC — no manual invoicing, no chasing payments.

## Agent Stack

PayLabs runs on a **LangGraph agent runtime** — a directed graph of LLM-powered and deterministic service nodes, each with its own x402 payment edge.

```
                              ┌─────────────┐
                              │    USER      │
                              │  UCW / DCW   │
                              └──────┬───────┘
                                     │ x402 entry payment
                                     ▼
                           ┌─────────────────────┐
                           │    ENTRY GATE        │
                           │  verify · settle     │
                           │  payer wallet check  │
                           └──────────┬───────────┘
                                      │
                                      ▼
              ┌───────────────────────────────────────────────┐
              │                   BRAIN                       │
              │          (LangGraph, always LLM)              │
              │                                               │
              │  • plans tier (easy / normal / advanced)       │
              │  • selects macro nodes + services              │
              │  • builds query variants + discovery strategy  │
              │  • advisory only — no prices, no wallets       │
              │                                               │
              │  buyer: run_budget_controller                  │
              │  seller: brain_service_wallet                  │
              └───────────────────────┬───────────────────────┘
                                      │ x402
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                  ▼
     ┌──────────────────────┐ ┌────────────────┐ ┌──────────────────────┐
     │  DISCOVERY PLANNER   │ │ PAYMENT DECIDE │ │  SETTLEMENT MEMORY   │
     │  (LangGraph)         │ │ (LangGraph)    │ │  (LangGraph)         │
     │                      │ │                │ │                      │
     │  easy: 3 services    │ │ normal: 5 svc  │ │  normal: 2 services  │
     │  normal: 3 services  │ │ adv: 5 svc     │ │  advanced: 3 services│
     └──────────┬───────────┘ └───────┬────────┘ └──────────┬───────────┘
                │ x402                │ x402                 │ x402
       ┌────────┼────────┐     ┌──────┼──────┐        ┌──────┼──────┐
       ▼        ▼        ▼     ▼      ▼      ▼        ▼      ▼      ▼
     ┌──────┐┌──────┐┌──────┐┌─────┐┌─────┐┌─────┐┌──────┐┌──────┐┌──────┐
     │intent││query ││signal││intnt││src  ││val  ││creat ││adv   ││creat │
     │plnnr ││bld   ││scout ││match││vrfy ││alloc││attrb ││evdnc ││payout│
     │      ││      ││      ││     ││     ││trst ││      ││eval  ││rtr   │
     │      ││      ││      ││     ││     ││pay  ││      ││      ││      │
     │      ││      ││      ││     ││     ││dcd  ││      ││      ││      │
     └──────┘└──────┘└──────┘└─────┘└─────┘└─────┘└──────┘└──────┘└──────┘

     ┌────────────────────────────────────────────────────────────────────┐
     │                    x402 PAYMENT GRAPH                             │
     │                                                                    │
     │  run_budget_controller → brain           (treasury fee)           │
     │  brain → discovery_planner               (macro node fee)        │
     │  brain → payment_decision                (macro node fee)        │
     │  brain → settlement_memory               (macro node fee)        │
     │  discovery_planner → intent_planner      (service edge fee)      │
     │  discovery_planner → query_builder       (service edge fee)      │
     │  discovery_planner → signal_scout        (service edge fee)      │
     │  payment_decision → intent_matcher       (service edge fee)      │
     │  payment_decision → source_verifier      (service edge fee)      │
     │  payment_decision → value_allocator      (service edge fee)      │
     │  payment_decision → trust_verifier       (service edge fee)      │
     │  payment_decision → payment_decider      (service edge fee)      │
     │  settlement_memory → creator_attribution (service edge fee)      │
     │  settlement_memory → adv_evidence_eval   (service edge fee)      │
     │  settlement_memory → creator_payout_rtr  (service edge fee)      │
     └────────────────────────────────────────────────────────────────────┘

     ┌────────────────────────────────────────────────────────────────────┐
     │                    CREATOR PAYOUT FLOW                            │
     │                                                                    │
     │  source_verifier ──► creator_attribution ──► creator_payout_router│
     │                           │                         │             │
     │                    claim resolver            split policy          │
     │                    (DB, no LLM)             85/10/5 atomic        │
     │                           │                         │             │
     │                    eligibility ──► claim-before-transfer          │
     │                    (deterministic)    (idempotent ledger)         │
     │                                            │                      │
     │                                    x402 → creator wallet         │
     └────────────────────────────────────────────────────────────────────┘

     ┌────────────────────────────────────────────────────────────────────┐
     │                    OUTPUT                                         │
     │                                                                    │
     │  source context ──► AI answer with citations                      │
     │  payment graph  ──► explorer page (tx hashes, batch links)        │
     │  receipts       ──► per-run breakdown (planned vs settled)        │
     │  creator payouts ──► payout ledger (per-creator USDC amounts)     │
     └────────────────────────────────────────────────────────────────────┘
```

**12 agent services** across 3 macro-node phases:

| Phase | Services | Role |
|-------|----------|------|
| **Discovery** | `intent_planner`, `query_builder`, `signal_scout` / `signal_scout_basics` | Understand user goal, build search queries, discover sources via RSSHub |
| **Payment Decision** | `intent_matcher`, `source_verifier`, `value_allocator`, `trust_verifier`, `payment_decider` | Match sources to intent, verify credibility, allocate value, decide payments |
| **Settlement** | `creator_attribution`, `advanced_evidence_evaluator`, `creator_payout_router` | Attribute sources to verified creators, evaluate evidence quality, route payouts |

Each service runs as an independent LangGraph node with its own x402 payment edge.

**Brain** = LLM planner. Chooses tier, services, search strategy. Advisory only — cannot set prices, wallets, or payment refs.

**Quote Engine** = deterministic pricing. Computes cost from tier + selected services. No LLM-generated prices.

### LLM vs Deterministic per service

Each service supports 3 execution modes: `deterministic` (default), `llm`, `hybrid`.

| Service | LLM-Capable | Default Mode | What LLM does (when enabled) |
|---------|-------------|-------------|------------------------------|
| **Brain planner** | ✅ always LLM | — | Plans tier, strategy, query variants. No deterministic fallback |
| `intent_planner` | ✅ | deterministic | LLM intent classification. Fail → rule-based fallback |
| `query_builder` | ✅ | deterministic | LLM query expansion/refinement. Fail → deterministic keyword expansion |
| `signal_scout` | ✅ | deterministic | LLM reranks top 20 candidates. Fail → metadata/keyword ranking |
| `signal_scout_basics` | ❌ | deterministic | Pure keyword/entity scoring. No LLM ever |
| `intent_matcher` | ✅ | deterministic | LLM relevance evaluation. Fail → keyword overlap scoring |
| `source_verifier` | ✅ | deterministic | LLM quality assessment. Fail → URL/domain/metadata validation |
| `value_allocator` | ✅ | deterministic | Budget math ALWAYS deterministic. LLM only writes explanation text |
| `trust_verifier` | ✅ | deterministic | Trust checks ALWAYS deterministic. LLM only writes risk summary |
| `payment_decider` | ❌ 🔒 | deterministic | **Hard-locked.** Pure aggregator. No LLM regardless of env |
| `creator_attribution` | ❌ | deterministic | Pure DB query + claim resolver. No LLM ever |
| `advanced_evidence_evaluator` | ✅ always LLM | LLM | Deep Agent with 7 tools (memory read/write, source comparison) |
| `creator_payout_router` | ❌ | deterministic | Deterministic split (85/10/5) + ledger. No LLM ever |

Key rules:
- `value_allocator` and `trust_verifier`: financial decisions (budget math, trust scores) are ALWAYS deterministic. LLM only generates human-readable explanation text
- `payment_decider`: hard-locked to deterministic — no env var can override
- Every LLM-capable service auto-falls back to deterministic on LLM failure
- `hybrid` mode = deterministic decision + LLM summary text only

## Creator Monetization

### How creators earn

```
1. Creator registers a source URL (GitHub repo, blog, domain)
2. Creator verifies ownership (DNS record, repo file, or backlink)
3. PayLabs ingests their content via RSSHub
4. User runs a search that uses the creator's source
5. Creator attribution service classifies eligibility (deterministic, no LLM)
6. Payout executor sends USDC to creator's wallet via x402/Gateway
```

### Revenue split (per creator slot)

| Recipient | Share | Per slot (USDC) |
|-----------|-------|-----------------|
| **Creator** | 85% | 0.000017 |
| **Bot** | 10% | 0.000002 |
| **Service** | 5% | 0.000001 |

Per-slot unit: 20 atomic (0.000020 USDC). Tier limits: Normal = 1 creator slot, Advanced = 2 creator slots. Easy = no creator payout.

### Verification methods

| Method | How it works |
|--------|-------------|
| `well_known_json` | Put `paylabs-verify.json` in your `.well-known/` directory |
| `github_repo_file` | Add `paylabs.json` to your repo root |
| `hosted_link_backlink` | Link back to PayLabs from your public bio/README |
| `manual_review` | Manual approval fallback |

### Claim resolution

When a discovery run finds sources, the **claim resolver** maps each source URL to a verified creator. Resolution priority:

1. `github_repo:<owner>/<repo>` — exact GitHub repo match
2. `platform_profile:<platform>:<handle>` — Twitter, YouTube, Medium, Substack
3. `host:<hostname>` — tenant hosts (`.vercel.app`, `.netlify.app`, `.github.io`)
4. `domain:<hostname>` — domain-level claim (fallback)
5. Exact `canonical_url` match — last resort

No LLM. No network calls. Pure DB query.

### Idempotent payout ledger

Every payout goes through `claim-before-transfer`:

1. `claimPending()` — insert pending row with unique constraint on `(run_id, payout_type, subject_id)`
2. If row already `paid`/`gateway_accepted` → skip (already done)
3. If row already `pending` → fail closed (concurrent claim)
4. Execute real x402 transfer via Circle Gateway
5. `markPaid()` or `markFailed()` — update with real settlement metadata

This prevents double-pay on retry, crash recovery, and concurrent requests.

## Route Tiers

| Tier | Macro Nodes | Creator Slots | Use Case |
|------|------------|---------------|----------|
| **Easy** | discovery_planner | 0 | Quick answer, no creator payout |
| **Normal** | discovery_planner, payment_decision | 1 | Source-backed answer with creator payout |
| **Advanced** | discovery_planner, payment_decision, settlement_memory | 2 | Deep evidence evaluation, 2 creator payouts |

Auto-tier: Brain selects optimal tier via two-step preflight (route-preflight → execute-locked).

## Payment Flow

```
User signs x402 entry payment
  → Brain plans tier + services
  → Quote engine prices the run (deterministic)
  → Agent wallets pay macro nodes + child services via x402
  → Creator attribution identifies eligible creators
  → Payout executor sends USDC to creator wallets
  → Receipt generated with full payment graph
```

## Wallets

**UCW (User-Controlled Wallet)** — production default. Social login, email OTP, PIN flow. User signs x402 entry payments. Circle W3S Web SDK in browser.

**DCW (Developer-Controlled Wallet)** — server-side alternative. Google OAuth + email OTP + passkey auth. Paid runs execute synchronously in-request.

## Auth

| Method | Implementation |
|--------|---------------|
| Google OAuth | ID token verified via Google `tokeninfo` endpoint |
| Email OTP | 6-digit code, SHA-256 hashed, 5min TTL, Resend delivery |
| WebAuthn Passkey | SimpleWebAuthn, credential stored server-side |

Sessions: JWT via `jose` (Edge-compatible), 7-day httpOnly cookie.

## Pages

| Route | What it does |
|-------|-------------|
| `/` | Chat — ask a question, connect wallet, run search |
| `/explorer` | Payment dashboard — KPIs, x402 events, creator payouts, treasury |
| `/receipts` | Receipt history — per-run breakdown with creators, sources, batch |
| `/source` | Feed items — RSSHub sources with citation/unlock pricing |
| `/creator-dashboard` | Creator onboarding — wallet + profile |
| `/creator-profile` | Creator claims — register, verify, monetize sources |
| `/creator-proof/[claimId]/[nonce]` | Public verification — verified creator badge |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 15, React 19, TypeScript |
| **Database** | Supabase (Postgres, RLS) |
| **Agent Runtime** | LangChain / LangGraph — directed graph orchestration |
| **Wallets** | Circle UCW (user-facing), Circle DCW (server-side) |
| **Payments** | x402 protocol, Circle Gateway, x402 batching |
| **Blockchain** | Arc Testnet (chain ID 5042002), viem |
| **Sources** | RSSHub — feed ingestion, route catalog, live search |
| **Auth** | jose (JWT), Resend (email), SimpleWebAuthn (passkeys) |
| **Validation** | Zod — schemas for all agent service I/O |

## Environment

```bash
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
PAYLABS_LLM_TIMEOUT_MS_DEFAULT
PAYLABS_LLM_MAX_TOKENS_DEFAULT

# Execution mode (per-service switchable)
PAYLABS_AGENT_SERVICE_EXECUTION_MODE
PAYLABS_AGENT_SERVICE_LLM_ENABLED
PAYLABS_AGENT_SERVICE_EXECUTION_MODE_<AGENT_KEY>
PAYLABS_AGENT_SERVICE_LLM_ENABLED_<AGENT_KEY>
```

## LLM Configuration

### Per-agent model routing

Each agent can use a different LLM provider, model, and base URL. Resolution:

```
PAYLABS_LLM_<FIELD>_<AGENT_KEY>  →  PAYLABS_LLM_<FIELD>_DEFAULT  →  hardcoded fallback
```

Example — 9Router as default provider:

```bash
# Default provider (OpenAI-compatible proxy)
PAYLABS_LLM_PROVIDER_DEFAULT=openai-compatible
PAYLABS_LLM_BASE_URL_DEFAULT=https://your-9router-endpoint.com/v1
PAYLABS_LLM_API_KEY_DEFAULT=your-api-key
PAYLABS_TUTOR_MODEL_DEFAULT=your-model-name
PAYLABS_LLM_REQUIRED=true

# Override specific agent to use a different model
PAYLABS_TUTOR_MODEL_INTENT_PLANNER=gpt-4o-mini
PAYLABS_LLM_BASE_URL_INTENT_PLANNER=https://your-other-provider.com/v1
PAYLABS_LLM_API_KEY_INTENT_PLANNER=your-other-key
```

### Execution mode switching

```bash
# All services deterministic (default — no LLM calls)
PAYLABS_AGENT_SERVICE_EXECUTION_MODE=deterministic
PAYLABS_AGENT_SERVICE_LLM_ENABLED=false

# All services LLM-enabled
PAYLABS_AGENT_SERVICE_EXECUTION_MODE=llm
PAYLABS_AGENT_SERVICE_LLM_ENABLED=true

# Per-service override (e.g. only intent_planner uses LLM)
PAYLABS_AGENT_SERVICE_EXECUTION_MODE_INTENT_PLANNER=llm
PAYLABS_AGENT_SERVICE_LLM_ENABLED_INTENT_PLANNER=true

# Hybrid mode — deterministic decision + LLM explanation
PAYLABS_AGENT_SERVICE_EXECUTION_MODE_SIGNAL_SCOUT=hybrid
PAYLABS_AGENT_SERVICE_LLM_ENABLED_SIGNAL_SCOUT=true
```

### Agent keys

9 delegated service agents that run in production:

| Agent Key | Phase | LLM-Capable |
|-----------|-------|-------------|
| `brain_planner` | Brain | ✅ always LLM |
| `intent_planner` | Discovery | ✅ |
| `query_builder` | Discovery | ✅ |
| `signal_scout` | Discovery | ✅ |
| `intent_matcher` | Payment Decision | ✅ |
| `source_verifier` | Payment Decision | ✅ |
| `value_allocator` | Payment Decision | ✅ |
| `trust_verifier` | Payment Decision | ✅ |
| `advanced_evidence_evaluator` | Settlement | ✅ always LLM |

Each key maps to `PAYLABS_LLM_PROVIDER_<KEY>`, `PAYLABS_TUTOR_MODEL_<KEY>`, `PAYLABS_LLM_BASE_URL_<KEY>`, `PAYLABS_LLM_API_KEY_<KEY>`, `PAYLABS_LLM_TIMEOUT_MS_<KEY>`, `PAYLABS_LLM_MAX_TOKENS_<KEY>`.

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
- Creator payout ledger is idempotent — claim-before-transfer prevents double-pay
