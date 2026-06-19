# PayLabs

**Pay only for what you learn.**

AI micro-learning buyer. User sets goal + budget, AI Tutor picks source-backed lessons, pays via x402 on Arc testnet. Creators receive receipt-backed payouts.

## Live Demo

- Landing: `/` - live counters from database
- Lessons: `/learn` - 8 source-backed micro-lessons
- Lesson: `/learn/[slug]` - preview free, full content behind x402 unlock
- AI Tutor: `/tutor` - goal + budget -> proposed path -> buy (via Runner)
- Receipts: `/receipts` - public payment records
- Creator: `/creator` - creator earnings dashboard

## Tech Stack

- Next.js 15 (App Router)
- Supabase (Postgres + RLS)
- Circle Gateway + x402 (nanopayments on Arc testnet)
- ArcLayer Runner (privileged payment execution)
- Viem (EVM utilities, EIP-712 verification)

## x402 Payment Flow (Verified)

1. Client requests lesson content
2. Server returns HTTP 402 with EIP-3009 TransferWithAuthorization challenge
3. Client signs the typed data with their wallet (MetaMask, etc.)
4. Client sends signed authorization to server
5. **Server verifies**: signature validity, amount, chain (5042002), USDC address, receiver, nonce uniqueness, authorization time window
6. Only after verification: server creates unlock + receipt records
7. Circle Gateway settles payment in batch (gas-free)

### Verification checks (server-side, before any DB write)

- Receiver address matches `X402_RECEIVER_ADDRESS`
- Amount matches lesson price in base units
- Chain ID is 5042002 (Arc testnet)
- USDC contract is `0x3600000000000000000000000000000000000000`
- Authorization is currently valid (`validAfter <= now <= validBefore`)
- Nonce/payment_id is unique (no duplicate payments)
- EIP-712 signature recovers to the `from` address

## Route-Tiered Agent Workflows

PayLabs supports 3 user-selectable learning routes. Each route has 5 route-specific agent prompts (15 total). All routes share one LangGraph orchestration engine, one shared Policy Guard, and one shared Payment & Receipt Executor.

| Route | Max Lessons | Reasoning Depth | Source Strictness | Best For |
|-------|-------------|-----------------|-------------------|----------|
| **Normal** | 2 | Low | Standard | Quick intro, cheapest useful path |
| **Advanced** | 5 | Medium | High | Technical builders, implementation-focused |
| **Premium** | 8 | High | Very High | Full mastery, architecture + safety + monetization |

### Architecture

- **One shared LangGraph orchestration engine** — no 15 separate payment systems
- **One shared Policy Guard core** — same safety checks for all tiers
- **One shared Payment & Receipt Executor** — all payments through ArcLayer Runner
- **Route tier changes planning behavior and prompt persona only**
- **Route tier NEVER weakens safety checks**

### Flow

```
Proposal: START -> intent_agent -> curriculum_planner_agent -> source_verifier_agent -> persist -> END
Buy:      START -> policy_guard_agent -> payment_receipt_executor_agent -> END
```

Proposal and buy remain separate invocations. User approval is required before any buy. Route tier does not bypass approval.

### Database

Route tier is persisted in `paylabs_learning_paths`:

- `route_tier` — `normal` | `advanced` | `premium` (default: `normal`)
- `route_config` — JSONB with tier config snapshot
- `agent_trace` — JSONB with per-agent execution trace

Migration: `supabase/migrations/003_route_tiered_agents.sql`

## Per-Agent LLM Routing

PayLabs supports per-agent model routing. Each LangGraph agent can be configured with its own provider, API key, base URL, and model through environment variables. The current budget-friendly deployment can route all agents to MiMo v2.5 Pro, while production deployments can selectively route planner, verifier, or policy agents to stronger models.

### Agent Key Mapping

| Agent | Env Key |
|-------|---------|
| `tutor_intake` | `INTAKE` |
| `intent` | `INTENT` |
| `curriculum_planner` | `PLANNER` |
| `source_verifier` | `VERIFIER` |
| `source_verifier_specialist` | `VERIFIER_SPECIALIST` |
| `specialist_payment_decision` | `SPECIALIST_DECISION` |
| `policy_guard` | `POLICY` |
| `payment_executor` | `EXECUTOR` |

### Config Resolution Order

Each field resolves independently:

- **provider:** `PAYLABS_LLM_PROVIDER_<AGENT_KEY>` → `PAYLABS_LLM_PROVIDER_DEFAULT` → `openai`
- **api key:** `PAYLABS_LLM_API_KEY_<AGENT_KEY>` → `PAYLABS_LLM_API_KEY_DEFAULT` → `PAYLABS_OPENAI_API_KEY` → `OPENAI_API_KEY`
- **base URL:** `PAYLABS_LLM_BASE_URL_<AGENT_KEY>` → `PAYLABS_LLM_BASE_URL_DEFAULT` → undefined
- **model:** `PAYLABS_TUTOR_MODEL_<AGENT_KEY>` → `PAYLABS_TUTOR_MODEL_DEFAULT` → `PAYLABS_TUTOR_MODEL` → `gpt-4o-mini`

If all agents should use the same model, only the DEFAULT variables are required. Per-agent variables override the default.

### Example Environment Variables

```bash
# --- LLM (all agents route to MiMo v2.5 Pro by default) ---
PAYLABS_LLM_REQUIRED=true

# Default config (used by all agents unless overridden)
PAYLABS_LLM_PROVIDER_DEFAULT=mimo
PAYLABS_LLM_BASE_URL_DEFAULT=https://mimo-api.example/v1
PAYLABS_LLM_API_KEY_DEFAULT=...
PAYLABS_TUTOR_MODEL_DEFAULT=mimo-v2.5-pro

# Per-agent overrides (optional — uncomment to use different models per agent)
# PAYLABS_LLM_PROVIDER_PLANNER=openai
# PAYLABS_LLM_BASE_URL_PLANNER=https://api.openai.com/v1
# PAYLABS_LLM_API_KEY_PLANNER=sk-...
# PAYLABS_TUTOR_MODEL_PLANNER=gpt-4o

# PAYLABS_LLM_PROVIDER_VERIFIER=openai
# PAYLABS_LLM_BASE_URL_VERIFIER=https://api.openai.com/v1
# PAYLABS_LLM_API_KEY_VERIFIER=sk-...
# PAYLABS_TUTOR_MODEL_VERIFIER=gpt-4o

# PAYLABS_LLM_PROVIDER_POLICY=openai
# PAYLABS_LLM_BASE_URL_POLICY=https://api.openai.com/v1
# PAYLABS_LLM_API_KEY_POLICY=sk-...
# PAYLABS_TUTOR_MODEL_POLICY=gpt-4o
```

## AI Tutor Budget Policy

Before any agent-initiated purchase, these checks must pass:

1. Learning path exists and belongs to user
2. Lesson is in the approved path
3. Lesson is published
4. Lesson has valid source hash
5. Creator wallet is verified
6. Price <= remaining budget
7. Price <= max lesson price (`PAYLABS_MAX_LESSON_PRICE_USDC`)
8. Lesson not already unlocked
9. ArcLayer Runner is available

Failed checks log `blocked_by_policy` action with the reason.

## ArcLayer Runner

All privileged payment execution goes through ArcLayer Runner:

- Runner handles Circle Developer-Controlled Wallet calls
- Runner handles x402 payment flow
- PayLabs never calls Circle, contracts, or wallet APIs directly
- Runner URL and API key configured via `ARCLAYER_RUNNER_URL` and `ARCLAYER_RUNNER_API_KEY`

## Source-Backed Lessons

Every lesson has:
- `source_url` - real public documentation URL (fetched and verified)
- `normalized_sha256` - hash of fetched source content (not just URL)
- `content_sha256` - hash of PayLabs-authored lesson content
- Creator wallet - verified EVM address

## Running Locally

```
git clone https://github.com/riyannode/Paylabs.git
cd Paylabs
pnpm install
cp .env.example .env.local
# Fill in .env.local with real values
pnpm seed:lessons
pnpm dev
```

## Seeding Lessons

```
pnpm seed:lessons
```

Creates 8 source-backed lessons. The seeder:
1. Fetches each allowlisted source URL
2. Extracts and normalizes the text
3. Computes SHA-256 of normalized content
4. Stores source metadata + hash
5. Creates lesson with content hash

## Verifying Live Payments

1. Open `/learn` - see 8 lessons with prices and source URLs
2. Open a lesson - see preview for free
3. Click "Connect Wallet to Unlock" - connects MetaMask
4. Sign the EIP-3009 authorization in your wallet
5. Server verifies signature before creating unlock
6. Open `/receipts` - see the payment record
7. Open `/creator` - check creator wallet earnings

## Revenue Split

- Creator: 85%
- Platform: 10%
- Treasury: 5%

## No Fake Receipts

PayLabs does not mark a lesson unlocked unless a valid EIP-3009 TransferWithAuthorization signature has been verified server-side. Receipt rows are created only after signature verification. There is no code path to create a receipt without a valid wallet signature.

## Environment Variables

See `.env.example` for the full list. Critical variables:

- `X402_RECEIVER_ADDRESS` - Where lesson payments go (must be valid EVM address)
- `PAYLABS_CREATOR_1_WALLET` / `PAYLABS_CREATOR_2_WALLET` - Creator wallets
- `PAYLABS_PLATFORM_WALLET` / `PAYLABS_TREASURY_WALLET` - Revenue split wallets
- `ARCLAYER_RUNNER_URL` / `ARCLAYER_RUNNER_API_KEY` - Runner for agent purchases
- `PAYLABS_MAX_LESSON_PRICE_USDC` - Max price an agent can pay (default 0.05)
- `PAYLABS_LLM_REQUIRED` - Set to `true` to require LLM (throws if no API key)
- `PAYLABS_LLM_PROVIDER_DEFAULT` / `PAYLABS_LLM_API_KEY_DEFAULT` - Default LLM config
- `PAYLABS_TUTOR_MODEL_DEFAULT` - Default model (fallback: `PAYLABS_TUTOR_MODEL`, then `gpt-4o-mini`)
