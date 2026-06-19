// PayLabs seed script: fetch allowlisted sources, normalize, hash, and seed 8 lessons.
// Run: npx tsx scripts/seed-lessons.ts

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREATOR_1 = process.env.PAYLABS_CREATOR_1_WALLET!;
const CREATOR_2 = process.env.PAYLABS_CREATOR_2_WALLET!;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeText(html: string): string {
  // Strip HTML tags, normalize whitespace, lowercase
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function fetchAndNormalize(url: string): Promise<{ title: string; text: string; normalized: string }> {
  console.log(`  Fetching: ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": "PayLabs-Seed/1.0 (educational content indexer)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const html = await res.text();

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : url;

  // Extract main text (rough)
  const bodyMatch = html.match(/<body[\s\S]*?<\/body>/i);
  const body = bodyMatch ? bodyMatch[0] : html;

  const normalized = normalizeText(body);

  return { title, text: body, normalized };
}

interface SourceDef {
  canonical_url: string;
  source_title: string;
  publisher: string;
  source_type: string;
  excerpt: string;
}

interface LessonDef {
  slug: string;
  title: string;
  summary: string;
  difficulty: string;
  estimated_minutes: number;
  price_usdc: number;
  tags: string[];
  source_index: number;
  creator_wallet: string;
  body: string;
}

const sources: SourceDef[] = [
  {
    canonical_url: "https://lepton.thecanteenapp.com/",
    source_title: "Lepton Agents Hackathon 2026",
    publisher: "The Canteen",
    source_type: "hackathon_page",
    excerpt: "Lepton hackathon focused on autonomous paying agents, creator monetization, and nanopayment infrastructure on Arc testnet.",
  },
  {
    canonical_url: "https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html",
    source_title: "Distribution Bootstrap for Payment Founders",
    publisher: "The Canteen",
    source_type: "analysis_article",
    excerpt: "Analysis of creator payment verticals, fee floor problems, and nanopayment settlement patterns for content creators.",
  },
  {
    canonical_url: "https://developers.circle.com/gateway/nanopayments",
    source_title: "Circle Gateway Nanopayments",
    publisher: "Circle",
    source_type: "documentation",
    excerpt: "Circle Gateway enables gas-free batched nanopayments with x402 protocol on Arc testnet.",
  },
  {
    canonical_url: "https://developers.circle.com/agent-stack",
    source_title: "Circle Agent Stack",
    publisher: "Circle",
    source_type: "documentation",
    excerpt: "Agent wallets, autonomous agent payment tooling, and Circle CLI for agentic payments.",
  },
  {
    canonical_url: "https://docs.arc.io/",
    source_title: "Arc Documentation",
    publisher: "Arc",
    source_type: "documentation",
    excerpt: "Arc chain context, network config, and agentic economy infrastructure.",
  },
  {
    canonical_url: "https://github.com/circlefin/arc-nanopayments",
    source_title: "arc-nanopayments Reference",
    publisher: "Circle",
    source_type: "reference_implementation",
    excerpt: "Buyer agent, seller endpoint, x402 protected route, Gateway batching, and Supabase payment persistence.",
  },
];

const lessons: LessonDef[] = [
  {
    slug: "why-subscriptions-fail-for-tiny-content",
    title: "Why subscriptions fail for tiny content",
    summary: "Per-piece content pricing was previously uneconomic. Nanopayments on Arc change the math entirely.",
    difficulty: "beginner",
    estimated_minutes: 5,
    price_usdc: 0.001,
    tags: ["creator monetization", "subscriptions", "nanopayments"],
    source_index: 0,
    creator_wallet: CREATOR_1,
    body: `# Why subscriptions fail for tiny content

## The problem

Traditional subscriptions bundle dozens of articles into a monthly fee. This works for Netflix. It fails for a single lesson about x402 payments.

When a creator publishes a 5-minute micro-lesson worth 0.001 USDC, no subscription model justifies charging $10/month. The economics break down:

- **High fixed costs**: Payment processing fees ($0.30 + 2.9%) dwarf the content price
- **Bundle pressure**: Platforms push creators into all-or-nothing publishing
- **Reader fatigue**: Users cancel subscriptions they barely use

## The nanopayment alternative

With Circle Gateway on Arc testnet, a 0.001 USDC payment costs effectively zero in gas fees. The x402 protocol handles the payment challenge, authorization, and settlement in a single HTTP round-trip.

This means:
1. A learner pays only for the lessons they actually need
2. A creator earns per lesson, not per subscription
3. No platform takes 30% of a $0.001 payment

## What this enables

PayLabs uses this pattern: an AI Tutor proposes a learning path from real source-backed lessons, the user approves a budget, and each lesson unlock happens via a live x402 payment on Arc testnet. The creator receives a receipt-backed payout record.

---

**Sources:**
- [Lepton Agents Hackathon 2026](https://lepton.thecanteenapp.com/)
- [Distribution Bootstrap for Payment Founders](https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html)`,
  },
  {
    slug: "circle-gateway-x402-flow",
    title: "Circle Gateway + x402 flow",
    summary: "Understand the 402 challenge, signed authorization, retry, verify, and serve pattern for nanopayments.",
    difficulty: "intermediate",
    estimated_minutes: 8,
    price_usdc: 0.002,
    tags: ["x402", "Circle Gateway", "nanopayments"],
    source_index: 2,
    creator_wallet: CREATOR_1,
    body: `# Circle Gateway + x402 flow

## How x402 works

The HTTP 402 status code was designed for digital cash payments. The x402 protocol brings it to life:

1. **Client requests a resource** (e.g., lesson content)
2. **Server responds with HTTP 402** + payment requirements
3. **Client signs a TransferWithAuthorization** (EIP-3009) using their wallet
4. **Client retries the request** with the signed authorization in headers
5. **Server verifies the signature** and creates an unlock record
6. **Gateway settles the payment** in a batch (gas-free)

## Circle Gateway specifics

Circle Gateway on Arc testnet provides:

- **USDC as native gas**: No ETH needed, all fees in USDC
- **Batched settlement**: Multiple payments settled in one onchain transaction
- **Unified balance**: Depositors see a single balance across domains
- **Permissionless reads**: /v1/balances requires no API key

The USDC contract on Arc testnet: 0x3600000000000000000000000000000000000000
Chain ID: 5042002

## EIP-3009 TransferWithAuthorization

The typed data structure uses these fields:
- from: address (sender)
- to: address (receiver)
- value: uint256 (amount in base units)
- validAfter: uint256 (timestamp)
- validBefore: uint256 (timestamp)
- nonce: bytes32 (unique per transaction)

The user signs this with their wallet. The server submits it to Gateway for batch settlement.

## In PayLabs

Every lesson unlock follows this exact flow. The AI Tutor never holds private keys. The user's wallet signs the authorization. The server verifies before creating any unlock or receipt record.

---

**Sources:**
- [Circle Gateway Nanopayments](https://developers.circle.com/gateway/nanopayments)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)`,
  },
  {
    slug: "autonomous-paying-agent-budget-policy",
    title: "Autonomous paying agent with budget policy",
    summary: "How an AI agent decides whether a paid resource is worth buying within a strict USDC budget.",
    difficulty: "intermediate",
    estimated_minutes: 7,
    price_usdc: 0.003,
    tags: ["AI agent", "budget", "autonomous payments"],
    source_index: 3,
    creator_wallet: CREATOR_2,
    body: `# Autonomous paying agent with budget policy

## The agent buying problem

An AI agent that can spend money needs guardrails. Without policy enforcement, an agent could:
- Spend the entire budget on one expensive resource
- Buy the same lesson twice
- Purchase from unverified creators
- Exceed the user's approved budget

## Budget policy design

PayLabs enforces these checks before any lesson purchase:

1. **Path must exist**: The user must have an approved learning path
2. **Lesson in path**: The lesson must be part of the approved path
3. **Not already unlocked**: No duplicate purchases
4. **Source verified**: The lesson must have a valid source hash
5. **Creator verified**: The creator wallet must be verified
6. **Price within limits**: price <= remaining budget AND price <= max lesson price
7. **Published only**: Only published lessons can be bought
8. **x402 valid**: The payment challenge must be current

If any check fails, the agent logs a blocked_by_policy action with the reason.

## Agent architecture

The PayLabs Tutor Agent:

- **Read-only tools**: List lessons, check unlocks, quote learning paths
- **Privileged tools**: Buy lesson (via ArcLayer Runner), mark complete
- **Never holds keys**: All payment execution goes through Runner
- **Never calls Circle directly**: Runner is the trust boundary

---

**Sources:**
- [Lepton Agents Hackathon 2026](https://lepton.thecanteenapp.com/)
- [Circle Agent Stack](https://developers.circle.com/agent-stack)
- [arc-nanopayments reference](https://github.com/circlefin/arc-nanopayments)`,
  },
  {
    slug: "creator-monetization-per-piece",
    title: "Creator monetization per piece",
    summary: "Pay-per-lesson and pay-per-article instead of subscription models for content creators.",
    difficulty: "beginner",
    estimated_minutes: 5,
    price_usdc: 0.002,
    tags: ["creator economy", "pay-per-piece", "publishing"],
    source_index: 1,
    creator_wallet: CREATOR_1,
    body: `# Creator monetization per piece

## The subscription trap

Most creator platforms push subscriptions: $5/month for all content. This works for prolific creators with large audiences. It fails for:

- Niche technical content (one great tutorial per month)
- Micro-lessons (5-minute explainers)
- Collaborative content (multiple contributors)

The subscriber sees: "I'm paying $5 for one article I actually read." Cancellation follows.

## Per-piece economics

With nanopayments, a creator can charge $0.001 to $0.05 per piece. The economics:

- 1000 readers paying $0.001 = $1.00 per lesson
- 100 lessons per month = $100/month from micro-content
- No subscription management, no churn tracking

## The fee floor problem

Traditional payment rails have a minimum viable transaction:
- Stripe: $0.30 + 2.9% → minimum ~$0.50
- PayPal: $0.49 fixed → minimum ~$1.00

Circle Gateway on Arc testnet: ~$0.00 gas → minimum viable at $0.000001 USDC.

This unlocks an entirely new creator economy where tiny payments are economically viable.

---

**Sources:**
- [Distribution Bootstrap for Payment Founders](https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html)
- [Lepton Agents Hackathon 2026](https://lepton.thecanteenapp.com/)`,
  },
  {
    slug: "arc-agentic-economy-basics",
    title: "Arc agentic economy basics",
    summary: "Why Arc is suitable for agent coordination and settlement with USDC as native gas.",
    difficulty: "beginner",
    estimated_minutes: 6,
    price_usdc: 0.002,
    tags: ["Arc", "agentic economy", "USDC gas"],
    source_index: 4,
    creator_wallet: CREATOR_2,
    body: `# Arc agentic economy basics

## What is Arc?

Arc is Circle's blockchain where USDC is the native gas token. Developers and users pay all transaction fees in USDC instead of ETH. This makes it ideal for:

- **USDC-first applications**: No ETH needed for anything
- **Predictable costs**: Gas fees in stable currency
- **Fast finality**: Sub-second confirmation times

## Network details

- Chain ID: 5042002 (testnet)
- RPC: https://rpc.testnet.arc.network
- Explorer: https://testnet.arcscan.app
- USDC: 0x3600000000000000000000000000000000000000

## Why agents need Arc

AI agents that transact need:
1. **Programmable money**: USDC with smart contract support
2. **Low fees**: Microtransactions viable at $0.001
3. **Fast settlement**: No waiting 15 minutes for confirmations
4. **No ETH dependency**: Agents shouldn't need ETH gas management

Arc provides all of this. An agent can buy a $0.001 lesson, pay $0.000001 gas, and settle in under a second.

## Dual decimals

Important: Arc uses 18 decimals for native gas (like ETH) but USDC ERC-20 uses 6 decimals. Mixing these up produces incorrect amounts.

---

**Sources:**
- [Arc Documentation](https://docs.arc.io/)
- [Arc MCP Documentation](https://docs.arc.io/ai/mcp)`,
  },
  {
    slug: "build-live-demo-with-real-receipts",
    title: "How to build a live demo with real receipts",
    summary: "What judges need to see in a hackathon demo: real payments, real receipts, no mock data.",
    difficulty: "beginner",
    estimated_minutes: 5,
    price_usdc: 0.001,
    tags: ["hackathon", "receipts", "live demo"],
    source_index: 5,
    creator_wallet: CREATOR_1,
    body: `# How to build a live demo with real receipts

## The fake demo problem

Many hackathon demos show:
- A nice UI with hardcoded data
- "Payment successful" messages without actual payments
- Receipts generated from mock database inserts
- Transaction hashes copied from block explorers

Judges can tell. And it disqualifies the project.

## What judges want to see

1. **Real transaction on a real network** (testnet is fine)
2. **Payment initiated by the demo** (not pre-staged)
3. **Receipt created from verified payment** (not mock insert)
4. **Verifiable on explorer** (tx hash links to actual transaction)
5. **Multiple transactions** (not just one lucky demo)

## The PayLabs approach

PayLabs enforces this at the code level:

- Content endpoint returns HTTP 402 (not 200) for unpaid requests
- Unlock requires signed EIP-3009 authorization from user's wallet
- Server verifies signature before creating any database record
- Receipt only created after payment verification
- No code path exists to create a receipt without payment

This means it's structurally impossible to fake a receipt. Even the developer can't create one without a real wallet signature.

---

**Sources:**
- [Lepton Agents Hackathon 2026](https://lepton.thecanteenapp.com/)
- [arc-nanopayments reference](https://github.com/circlefin/arc-nanopayments)`,
  },
  {
    slug: "revenue-splits-for-collaborative-content",
    title: "Revenue splits for collaborative content",
    summary: "How metadata and receipts can become payout logic for multi-creator content.",
    difficulty: "intermediate",
    estimated_minutes: 7,
    price_usdc: 0.004,
    tags: ["revenue split", "receipts", "payout"],
    source_index: 1,
    creator_wallet: CREATOR_2,
    body: `# Revenue splits for collaborative content

## The collaboration problem

A lesson might involve:
- A subject matter expert who writes the content
- A platform that hosts and serves it
- A treasury that funds development

How do you split a $0.001 payment three ways?

## PayLabs split model

PayLabs uses a fixed basis-point split:
- Creator: 85% (8500 bps)
- Platform: 10% (1000 bps)
- Treasury: 5% (500 bps)

For a 0.001 USDC lesson:
- Creator receives: 0.00085 USDC
- Platform receives: 0.00010 USDC
- Treasury receives: 0.00005 USDC

## Receipt-backed records

Each payment creates a paylabs_payout_receipts row with:
- Gross amount
- Creator amount
- Platform amount
- Treasury amount
- Payment reference
- Transaction hash (when settled)

The receipt is the source of truth. The UI reads from receipts, not from wallet balances. This means the creator dashboard shows verified earnings, not estimated amounts.

## Settlement vs receipt

Important distinction:
- **Receipt**: Created immediately after payment verification (server-side)
- **Settlement**: Happens when Circle Gateway batches the payment onchain

The UI must say "receipt-backed split record" until actual onchain settlement is confirmed.

---

**Sources:**
- [Distribution Bootstrap for Payment Founders](https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html)
- [ArcLayer reference](https://github.com/riyannode/ArcLayer)`,
  },
  {
    slug: "arclayer-x402-and-identity-rails",
    title: "ArcLayer x402 and identity rails",
    summary: "Access rail vs identity rail: how x402 handles paid access and ERC-8004 handles agent identity.",
    difficulty: "advanced",
    estimated_minutes: 10,
    price_usdc: 0.005,
    tags: ["ArcLayer", "x402", "ERC-8004", "identity"],
    source_index: 5,
    creator_wallet: CREATOR_2,
    body: `# ArcLayer x402 and identity rails

## Two rails for agents

ArcLayer provides two protocol rails:

1. **x402 paid access rail**: Lightweight payment for API/resource access
2. **ERC-8004 identity rail**: Persistent agent identity and reputation

These serve different purposes and should not be confused.

## x402 paid access rail

Use x402 for:
- Protected API access
- Pay-per-call resources
- Lesson/content unlocks
- Lightweight A2A service calls

Flow: Client requests → 402 challenge → Client signs → Server verifies → Content served

The payment is ephemeral. There's no persistent state beyond the receipt.

## ERC-8004 identity rail

Use ERC-8004 for:
- Agent registration (onchain identity)
- Reputation tracking
- Validation records

Flow: Agent calls register(metadataURI) → Gets tokenId → tokenId is the agent ID

The identity persists onchain. Other agents can verify it.

## When to use which

| Need | Rail |
|------|------|
| Pay for a resource | x402 |
| Prove agent identity | ERC-8004 |
| Track reputation | ERC-8004 |
| Unlock content | x402 |
| Escrow for job | ERC-8183 |

## In PayLabs

PayLabs uses x402 for lesson unlocks (lightweight, per-lesson). It uses ERC-8004 for the Tutor Agent identity (persistent, verifiable).

---

**Sources:**
- [ArcLayer reference](https://github.com/riyannode/ArcLayer)
- [arc-nanopayments reference](https://github.com/circlefin/arc-nanopayments)`,
  },
];

async function main() {
  console.log("PayLabs Seed: 8 source-backed lessons\n");

  // Validate wallets
  for (const [name, addr] of Object.entries({ CREATOR_1, CREATOR_2 })) {
    if (!addr || !addr.startsWith("0x") || addr.length !== 42) {
      console.error(`ERROR: ${name} is not a valid EVM address: "${addr}"`);
      process.exit(1);
    }
  }

  // Fetch and process sources
  const sourceIds: string[] = [];
  for (const s of sources) {
    let normalizedSha = "";
    let excerpt = s.excerpt;

    try {
      const { title, normalized } = await fetchAndNormalize(s.canonical_url);
      normalizedSha = sha256(normalized);
      // Use first 280 chars of normalized text as excerpt if we fetched it
      if (normalized.length > 20) {
        excerpt = normalized.slice(0, 280);
      }
      console.log(`  Fetched: ${title} (${normalized.length} chars, hash: ${normalizedSha.slice(0, 16)}...)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  WARN: Could not fetch ${s.canonical_url}: ${msg}`);
      // Still create the source, but with a hash of URL+title as fallback
      normalizedSha = sha256(JSON.stringify({ url: s.canonical_url, title: s.source_title }));
    }

    const { data, error } = await supabase
      .from("paylabs_sources")
      .upsert(
        {
          canonical_url: s.canonical_url,
          source_title: s.source_title,
          publisher: s.publisher,
          source_type: s.source_type,
          normalized_sha256: normalizedSha,
          excerpt,
          license_note: "Public documentation, fair use for educational purposes",
        },
        { onConflict: "canonical_url" }
      )
      .select("id")
      .single();

    if (error) {
      console.error("Source upsert error:", error);
      process.exit(1);
    }
    sourceIds.push(data.id);
    console.log(`  Source: ${s.source_title} -> ${data.id}`);
  }

  // Upsert creators
  const creatorRows = [
    { display_name: "Riyan / PayLabs Curator", wallet_address: CREATOR_1 },
    { display_name: "ArcLayer Builder", wallet_address: CREATOR_2 },
  ];
  const creatorMap: Record<string, string> = {};
  for (const c of creatorRows) {
    const { data, error } = await supabase
      .from("paylabs_creators")
      .upsert(
        { display_name: c.display_name, wallet_address: c.wallet_address.toLowerCase(), is_verified: true },
        { onConflict: "wallet_address" }
      )
      .select("id, wallet_address")
      .single();
    if (error) {
      console.error("Creator upsert error:", error);
      process.exit(1);
    }
    creatorMap[data.wallet_address.toLowerCase()] = data.id;
    console.log(`  Creator: ${c.display_name} -> ${data.id}`);
  }

  // Upsert lessons
  for (const l of lessons) {
    const content_sha256 = sha256(l.body);
    const creator_id = creatorMap[l.creator_wallet.toLowerCase()];

    const { data, error } = await supabase
      .from("paylabs_lessons")
      .upsert(
        {
          slug: l.slug,
          title: l.title,
          summary: l.summary,
          body_markdown: l.body,
          source_id: sourceIds[l.source_index],
          creator_id,
          price_usdc: l.price_usdc,
          estimated_minutes: l.estimated_minutes,
          difficulty: l.difficulty,
          tags: l.tags,
          content_sha256,
          is_published: true,
        },
        { onConflict: "slug" }
      )
      .select("id, slug, title")
      .single();

    if (error) {
      console.error("Lesson upsert error:", error);
      process.exit(1);
    }
    console.log(`  Lesson: ${l.title} -> ${data.id}`);
  }

  console.log(`\nDone. ${lessons.length} lessons seeded from ${sources.length} sources.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
