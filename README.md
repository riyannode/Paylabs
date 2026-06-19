# PayLabs

**AI source-feed learning paths with creator citation tolls.**

PayLabs ingests RSSHub/RSS feeds, turns feed items into source-backed learning cards, and prepares citation/unlock payments so creators can be paid when their sources are used, cited, or consumed.

## RSSHub Distribution Bootstrap

RSSHub-style feeds are the distribution layer. PayLabs adds AI planning, source verification, payment proof, and creator payout receipts.

This maps to:
- **RFB 06** — Creator & Publisher Monetization
- **RFB 01** — Autonomous Paying Agents
- **RFB 03** — Agent-to-Agent Nanopayment Networks

```
flowchart TD
  RSS[RSSHub / RSS Feed] --> SYNC[RSSHub Sync]
  SYNC --> ITEMS[(Feed Items)]
  ITEMS --> SOURCES[Sources Catalog]
  ITEMS --> TUTOR[AI Tutor]
  TUTOR --> PLAN[Source Path]
  PLAN --> VERIFY[Source Verifier]
  VERIFY --> PAY[Citation / Unlock Toll]
  PAY --> CREATOR[Creator Wallet]
  PAY --> RECEIPT[(Citation Receipt)]
  RECEIPT --> DASH[Dashboard]
```

## Route Tiers

PayLabs supports 3 user-selectable source paths. Internal DB values unchanged; public labels updated.

| Public Label | Internal Tier | Max Source Cards | Source Strictness | Best For |
|-------------|---------------|-----------------|-------------------|----------|
| **Easy** | `normal` | 2 | Standard | Quick intro, cheapest path |
| **Normal** | `advanced` | 5 | High | Balanced source path |
| **Advanced** | `premium` | 8 | Very High | Deep research path |

## Architecture

- **One shared LangGraph orchestration engine** — all tiers
- **One shared Policy Guard core** — same safety checks for all tiers
- **One shared Payment & Receipt Executor** — all payments through ArcLayer Runner
- **Route tier changes planning behavior and prompt persona only**
- **Route tier NEVER weakens safety checks**

### Flow

```
Proposal: START -> intent_agent -> curriculum_planner_agent -> source_verifier_agent -> persist -> END
Buy:      START -> policy_guard_agent -> payment_receipt_executor_agent -> END
```

Proposal and buy remain separate invocations. User approval is required before any buy.

## Per-Agent LLM Routing

PR #9 per-agent LLM routing remains runtime configuration. Each LangGraph agent can be configured with its own provider, API key, base URL, and model through environment variables. See `.env.example` for the full mapping.

## x402 Payment Flow (Verified)

1. Client requests lesson/content
2. Server returns HTTP 402 with EIP-3009 TransferWithAuthorization challenge
3. Client signs the typed data with their wallet
4. **Server verifies**: signature validity, amount, chain (5042002), USDC address, receiver, nonce uniqueness
5. Only after verification: server creates unlock + receipt records
6. Circle Gateway settles payment in batch (gas-free)

## Tech Stack

- Next.js 15 (App Router)
- Supabase (Postgres + RLS)
- Circle Gateway + x402 (nanopayments on Arc testnet)
- ArcLayer Runner (privileged payment execution)
- rss-parser (RSSHub feed parsing)
- Viem (EVM utilities, EIP-712 verification)

## Live Demo

- `/` — Landing page
- `/sources` — RSSHub feed items catalog
- `/tutor` — AI tutor: goal + budget → source path → buy
- `/dashboard` — RSSHub-first activity dashboard
- `/receipts` — Public payment records
- `/creator` — Creator earnings dashboard

## Running Locally

```
git clone https://github.com/riyannode/Paylabs.git
cd Paylabs
pnpm install
cp .env.example .env.local
# Fill in .env.local with real values
pnpm dev
```

## RSSHub Sync

Create routes and sync feed items:

```bash
# Create a route
curl -X POST http://localhost:3000/api/paylabs/rsshub/routes \
  -H "Content-Type: application/json" \
  -d '{"rsshub_base_url":"https://rsshub.app","route_path":"/hackernews/best","title":"Hacker News Best","creator_wallet":"0x..."}'

# Sync all routes (requires PAYLABS_RSSHUB_SYNC_SECRET)
curl -X POST http://localhost:3000/api/paylabs/rsshub/sync \
  -H "Authorization: Bearer $PAYLABS_RSSHUB_SYNC_SECRET"
```

## Demo Reset

Clear internal demo lesson data (manual only):

```bash
pnpm clear:demo-lessons                # Clear lesson data only
pnpm clear:demo-lessons --include-payments  # Also clear payment tables
```

## Database

New tables (migration 006):
- `paylabs_rsshub_routes` — RSSHub feed source configuration
- `paylabs_feed_items` — Normalized feed items with content hashes
- `paylabs_citation_receipts` — Citation/unlock payment records

Existing tables preserved: `paylabs_lessons`, `paylabs_creators`, `paylabs_unlocks`, `paylabs_payout_receipts`, `paylabs_route_toll_calls`, `paylabs_agent_service_calls`, `paylabs_learning_paths`.

## Revenue Split

- Creator: 85%
- Platform: 10%
- Treasury: 5%

## No Fake Receipts

PayLabs does not create receipt records without valid EIP-3009 TransferWithAuthorization signature verification. No fake payments. No fake tx hashes. No secrets in logs.

## Environment Variables

See `.env.example` for the full list. Critical variables:

- `X402_RECEIVER_ADDRESS` — Where payments go
- `PAYLABS_RSSHUB_SYNC_SECRET` — Bearer token for sync endpoint
- `PAYLABS_RSSHUB_DEFAULT_BASE_URL` — Default RSSHub instance
- `PAYLABS_LLM_PROVIDER_DEFAULT` / `PAYLABS_LLM_API_KEY_DEFAULT` — LLM config
- `ARCLAYER_RUNNER_URL` / `ARCLAYER_RUNNER_API_KEY` — Runner for payments
