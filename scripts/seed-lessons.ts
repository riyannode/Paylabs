// Seed 3 real source-backed lessons for PayLabs MVP
// Run: pnpm seed:lessons

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CREATOR_1_WALLET = process.env.PAYLABS_CREATOR_1_WALLET!;
const CREATOR_2_WALLET = process.env.PAYLABS_CREATOR_2_WALLET!;
const PLATFORM_WALLET = process.env.PAYLABS_PLATFORM_WALLET!;
const TREASURY_WALLET = process.env.PAYLABS_TREASURY_WALLET!;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const sources = [
  {
    canonical_url: "https://lepton.thecanteenapp.com/",
    source_title: "Lepton Agents Hackathon 2026",
    publisher: "The Canteen",
    source_type: "hackathon_page",
    excerpt: "Lepton is a hackathon focused on autonomous paying agents, creator monetization, and nanopayment infrastructure on Arc testnet.",
  },
  {
    canonical_url: "https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html",
    source_title: "Distribution Bootstrap for Payment Founders",
    publisher: "The Canteen",
    source_type: "analysis_article",
    excerpt: "Analysis of creator payment verticals, fee floor problems, and nanopayment settlement patterns.",
  },
  {
    canonical_url: "https://developers.circle.com/gateway/nanopayments",
    source_title: "Circle Gateway Nanopayments",
    publisher: "Circle",
    source_type: "documentation",
    excerpt: "Circle Gateway enables gas-free batched nanopayments with x402 protocol on Arc testnet.",
  },
];

function buildLesson1(): string {
  return [
    "# Why subscriptions fail for tiny content",
    "",
    "## The problem",
    "",
    "Traditional subscriptions bundle dozens of articles, videos, or lessons into a single monthly fee.",
    "This works for Netflix. It fails for a single lesson about x402 payments.",
    "",
    "When a creator publishes a 5-minute micro-lesson worth 0.001 USDC, no subscription model can justify",
    "charging $10/month for access. The economics break down:",
    "",
    "- **High fixed costs**: Payment processing fees ($0.30 + 2.9%) dwarf the content price",
    "- **Bundle pressure**: Platforms push creators into all-or-nothing publishing",
    "- **Reader fatigue**: Users cancel subscriptions they barely use",
    "",
    "## The nanopayment alternative",
    "",
    "With Circle Gateway on Arc testnet, a 0.001 USDC payment costs effectively zero in gas fees.",
    "The x402 protocol handles the payment challenge, authorization, and settlement in a single HTTP round-trip.",
    "",
    "This means:",
    "1. A learner pays only for the 3 lessons they actually need",
    "2. A creator earns per lesson, not per subscription",
    "3. No platform takes 30% of a $0.001 payment",
    "",
    "## What this enables",
    "",
    "PayLabs uses this pattern: an AI Tutor proposes a learning path from real source-backed lessons,",
    "the user approves a budget, and each lesson unlock happens via a live x402 payment on Arc testnet.",
    "The creator receives a receipt-backed payout record.",
    "",
    "No fake payments. No mock receipts. Every unlock is verified.",
    "",
    "---",
    "",
    "**Sources:**",
    "- [Lepton Agents Hackathon 2026](https://lepton.thecanteenapp.com/)",
    "- [Distribution Bootstrap for Payment Founders](https://thecanteenapp.com/analysis/2026/05/28/distribution-bootstrap-payments-founders.html)",
  ].join("\n");
}

function buildLesson2(): string {
  return [
    "# Circle Gateway + x402 flow",
    "",
    "## How x402 works",
    "",
    "The HTTP 402 status code was designed for digital cash payments. The x402 protocol brings it to life:",
    "",
    "1. **Client requests a resource** (e.g., lesson content)",
    "2. **Server responds with HTTP 402** + payment requirements",
    "3. **Client signs a TransferWithAuthorization** (EIP-3009) using their wallet",
    "4. **Client retries the request** with the signed authorization in headers",
    "5. **Server verifies the signature** and creates an unlock record",
    "6. **Gateway settles the payment** in a batch (gas-free)",
    "",
    "## Circle Gateway specifics",
    "",
    "Circle Gateway on Arc testnet provides:",
    "",
    "- **USDC as native gas**: No ETH needed, all fees in USDC",
    "- **Batched settlement**: Multiple payments settled in one onchain transaction",
    "- **Unified balance**: Depositors see a single balance across domains",
    "- **Permissionless reads**: /v1/balances requires no API key",
    "",
    "The USDC contract on Arc testnet:",
    "0x3600000000000000000000000000000000000000",
    "",
    "Chain ID: 5042002 (hex: 0x4CEF52)",
    "",
    "## EIP-3009 TransferWithAuthorization",
    "",
    "The typed data structure uses these fields:",
    "- from: address (sender)",
    "- to: address (receiver)",
    "- value: uint256 (amount in base units)",
    "- validAfter: uint256 (timestamp)",
    "- validBefore: uint256 (timestamp)",
    "- nonce: bytes32 (unique per transaction)",
    "",
    "The user signs this with their wallet. The server submits it to Gateway for batch settlement.",
    "",
    "## In PayLabs",
    "",
    "Every lesson unlock follows this exact flow. The AI Tutor never holds private keys.",
    "The user's wallet signs the authorization. The server verifies before creating any unlock or receipt record.",
    "",
    "---",
    "",
    "**Sources:**",
    "- [Circle Gateway Nanopayments](https://developers.circle.com/gateway/nanopayments)",
    "- [Circle Agent Stack](https://developers.circle.com/agent-stack)",
  ].join("\n");
}

function buildLesson3(): string {
  return [
    "# Autonomous paying agent with budget policy",
    "",
    "## The agent buying problem",
    "",
    "An AI agent that can spend money needs guardrails. Without policy enforcement, an agent could:",
    "- Spend the entire budget on one expensive resource",
    "- Buy the same lesson twice",
    "- Purchase from unverified creators",
    "- Exceed the user's approved budget",
    "",
    "## Budget policy design",
    "",
    "PayLabs enforces these checks before any lesson purchase:",
    "",
    "1. **Path must exist**: The user must have an approved learning path",
    "2. **Lesson in path**: The lesson must be part of the approved path",
    "3. **Not already unlocked**: No duplicate purchases",
    "4. **Source verified**: The lesson must have a valid source hash",
    "5. **Creator verified**: The creator wallet must be verified",
    "6. **Price within limits**: price <= remaining budget AND price <= max lesson price",
    "7. **Published only**: Only published lessons can be bought",
    "8. **x402 valid**: The payment challenge must be current",
    "",
    "If any check fails, the agent logs a blocked_by_policy action with the reason.",
    "",
    "## Agent architecture",
    "",
    "The PayLabs Tutor Agent:",
    "",
    "- **Read-only tools**: List lessons, check unlocks, quote learning paths",
    "- **Privileged tools**: Buy lesson (via ArcLayer Runner), mark complete",
    "- **Never holds keys**: All payment execution goes through Runner",
    "- **Never calls Circle directly**: Runner is the trust boundary",
    "",
    "## What the agent sees",
    "",
    "Goal: Learn x402 nanopayments and agentic commerce",
    "Budget: 0.01 USDC",
    "",
    "Proposed path:",
    "1. Why subscriptions fail for tiny content (0.001 USDC)",
    "   Reason: Foundation concept for understanding why nanopayments matter",
    "2. Circle Gateway + x402 flow (0.002 USDC)",
    "   Reason: Core payment mechanism you need to understand",
    "3. Autonomous paying agent (0.003 USDC)",
    "   Reason: How agents use x402 with budget constraints",
    "",
    "Total: 0.006 USDC (within 0.01 budget)",
    "",
    "The user approves the path and budget. Only then can the agent buy.",
    "",
    "---",
    "",
    "**Sources:**",
    "- [Lepton Agents Hackathon 2026](https://lepton.thecanteenapp.com/)",
    "- [Circle Agent Stack](https://developers.circle.com/agent-stack)",
    "- [arc-nanopayments reference](https://github.com/circlefin/arc-nanopayments)",
  ].join("\n");
}

const lessons = [
  {
    slug: "why-subscriptions-fail-for-tiny-content",
    title: "Why subscriptions fail for tiny content",
    summary: "Per-piece content pricing was previously uneconomic. Nanopayments on Arc change the math entirely.",
    difficulty: "beginner",
    estimated_minutes: 5,
    price_usdc: 0.001,
    tags: ["creator monetization", "subscriptions", "nanopayments"],
    source_index: 0,
    creator_wallet: CREATOR_1_WALLET,
    bodyFn: buildLesson1,
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
    creator_wallet: CREATOR_1_WALLET,
    bodyFn: buildLesson2,
  },
  {
    slug: "autonomous-paying-agent-budget-policy",
    title: "Autonomous paying agent with budget policy",
    summary: "How an AI agent decides whether a paid resource is worth buying within a strict USDC budget.",
    difficulty: "intermediate",
    estimated_minutes: 7,
    price_usdc: 0.003,
    tags: ["AI agent", "budget", "autonomous payments"],
    source_index: 0,
    creator_wallet: CREATOR_2_WALLET,
    bodyFn: buildLesson3,
  },
];

async function main() {
  console.log("PayLabs Seed: 3 source-backed lessons\n");

  // Validate wallets
  const wallets = { CREATOR_1_WALLET, CREATOR_2_WALLET, PLATFORM_WALLET, TREASURY_WALLET };
  for (const [name, addr] of Object.entries(wallets)) {
    if (!addr || !addr.startsWith("0x") || addr.length !== 42) {
      console.error(`ERROR: ${name} is not a valid EVM address: "${addr}"`);
      process.exit(1);
    }
  }

  // Upsert sources
  const sourceIds: string[] = [];
  for (const s of sources) {
    const normalized = JSON.stringify({ url: s.canonical_url, title: s.source_title });
    const { data, error } = await supabase
      .from("paylabs_sources")
      .upsert(
        {
          canonical_url: s.canonical_url,
          source_title: s.source_title,
          publisher: s.publisher,
          source_type: s.source_type,
          normalized_sha256: sha256(normalized),
          excerpt: s.excerpt,
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
    { display_name: "Riyan / PayLabs Curator", wallet_address: CREATOR_1_WALLET },
    { display_name: "ArcLayer Builder", wallet_address: CREATOR_2_WALLET },
  ];
  const creatorMap: Record<string, string> = {};
  for (const c of creatorRows) {
    const { data, error } = await supabase
      .from("paylabs_creators")
      .upsert(
        { display_name: c.display_name, wallet_address: c.wallet_address, is_verified: true },
        { onConflict: "wallet_address" }
      )
      .select("id, wallet_address")
      .single();
    if (error) {
      console.error("Creator upsert error:", error);
      process.exit(1);
    }
    creatorMap[data.wallet_address] = data.id;
    console.log(`  Creator: ${c.display_name} -> ${data.id}`);
  }

  // Upsert lessons
  for (const l of lessons) {
    const body = l.bodyFn();
    const content_sha256 = sha256(body);
    const creator_id = creatorMap[l.creator_wallet];

    const { data, error } = await supabase
      .from("paylabs_lessons")
      .upsert(
        {
          slug: l.slug,
          title: l.title,
          summary: l.summary,
          body_markdown: body,
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

  console.log("\nDone. 3 lessons seeded with real sources.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
