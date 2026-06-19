# PayLabs

**Pay only for what you learn.**

AI micro-learning buyer. User sets goal + budget, AI Tutor picks source-backed lessons, pays via x402 on Arc testnet. Creators receive receipt-backed payouts.

## Lepton Agents Hackathon 2026

- **RFB 01**: Autonomous Paying Agents
- **RFB 06**: Creator and Publisher Monetization

## Live Demo

- Landing: `/` - live counters from database
- Lessons: `/learn` - 3 source-backed micro-lessons
- Lesson: `/learn/[slug]` - preview free, full content behind x402
- AI Tutor: `/tutor` - goal + budget -> proposed path -> buy
- Receipts: `/receipts` - public payment records
- Creator: `/creator` - creator earnings dashboard

## Tech Stack

- Next.js 15 (App Router)
- Supabase (Postgres + RLS)
- Circle Gateway + x402 (nanopayments on Arc testnet)
- Viem (EVM utilities)
- Cheerio (source extraction)

## How It Works

1. User enters a learning goal and USDC budget
2. AI Tutor proposes a path from real source-backed lessons
3. User approves the path
4. Each lesson unlock is a live x402 payment on Arc testnet
5. Creator receives a receipt-backed payout record (85/10/5 split)

## Source-Backed Lessons

Every lesson has:
- `source_url` - real public documentation URL
- `source_sha256` - hash of normalized source text
- `content_sha256` - hash of PayLabs-authored lesson content
- Creator wallet - verified EVM address

## x402 Payment Flow

1. Client requests lesson content
2. Server returns HTTP 402 with payment challenge (EIP-3009 TransferWithAuthorization)
3. Client signs with wallet
4. Server verifies signature, creates unlock + receipt
5. Circle Gateway settles in batch (gas-free)

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

Creates 3 source-backed lessons from:
- Lepton Agents Hackathon page
- Circle Gateway nanopayments docs
- The Canteen distribution analysis

## Verifying Live Payments

1. Open `/learn` - see 3 lessons with prices and source URLs
2. Open a lesson - see preview for free
3. Click Unlock - payment creates a real receipt
4. Open `/receipts` - see the payment record
5. Open `/creator` - check creator wallet earnings

## Revenue Split

- Creator: 85%
- Platform: 10%
- Treasury: 5%

## Known Limitations

- ERC-8183 is disabled (Circle SDK bytes params blocked on ARC-TESTNET)
- AI Tutor is a deterministic helper (no external LLM for MVP)
- Demo user wallet is "demo-user" (real wallet integration is WIP)
- Settlement is receipt-backed (not immediate onchain split)

## No Fake Receipts

PayLabs does not mark a lesson unlocked unless a payment record is created.
Receipt rows exist only after the unlock transaction. No mock data, no fake tx hashes.
