# PayLabs x402 API Endpoints

All agent execution endpoints enforce **x402 paywall** — requests without valid payment return `402 Payment Required` with a Circle Gateway payment challenge.

**Base URL:** `https://paylabs.vercel.app`

**x402 flow:**
1. Call endpoint → receive `402` + `payment-required` / `x-payment-required` header (JWT)
2. Decode JWT → get `amount`, `payTo` wallet, `network` (Arc testnet)
3. Submit payment via Circle Gateway
4. Retry original request with payment proof

---

## 1. Brain (Top-level Orchestrator)

The entry point. Routes through the full pipeline: macro-nodes → agent-services → settlement.

```bash
curl -i -X POST https://paylabs.vercel.app/api/paylabs/brain/run \
  -H "Content-Type: application/json" \
  -d '{
    "userGoal": "What sources discuss x402 micropayments?",
    "routeTier": "normal",
    "discoveryRunId": "your-run-id"
  }'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `userGoal` | string | ✅ | What the user is searching for |
| `routeTier` | `"easy"` \| `"normal"` \| `"advanced"` | ✅ | Pipeline complexity tier |
| `discoveryRunId` | string | ✅ | Unique run identifier |

**x402 amount:** 0.000003 USDC (Arc testnet)

---

## 2. Macro Nodes

Individual pipeline phases. Each macro-node runs its child agent-services.

```bash
curl -i -X POST https://paylabs.vercel.app/api/paylabs/macro-nodes/{nodeName}/run \
  -H "Content-Type: application/json" \
  -d '{
    "userGoal": "What sources discuss x402 micropayments?",
    "routeTier": "normal",
    "discoveryRunId": "your-run-id"
  }'
```

### Valid macro-node names

| Name | Tier | Child Services |
|---|---|---|
| `discovery_planner` | easy | `intent_planner`, `query_builder`, `signal_scout_basics` |
| `payment_decision` | normal | `intent_matcher`, `source_verifier`, `value_allocator`, `trust_verifier`, `payment_decider` |
| `settlement_memory` | advanced | `creator_attribution`, `advanced_evidence_evaluator`, `creator_payout_router` |

> ⚠️ Names use **underscores** not hyphens: `discovery_planner` ✅ `discovery-planner` ❌

**x402 amount:** 0.000004 USDC (discovery_planner) — varies per node

---

## 3. Agent Services

Individual agents. Requires nested `payload` object + `buyerAgentName` (edge-allowlist checked).

```bash
curl -i -X POST https://paylabs.vercel.app/api/paylabs/agent-services/{serviceName}/run \
  -H "Content-Type: application/json" \
  -d '{
    "buyerAgentName": "discovery_planner",
    "discoveryRunId": "your-run-id",
    "payload": {
      "goal": "What sources discuss x402 micropayments?",
      "budgetUsdc": 0.01
    }
  }'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `buyerAgentName` | string | ✅ | Calling agent (edge-allowlist enforced) |
| `discoveryRunId` | string | ✅ | Unique run identifier |
| `payload` | object | ✅ | Service-specific input (see schemas below) |

### Valid service names & allowed buyers

| Service | Parent Macro-Node | Valid `buyerAgentName` |
|---|---|---|
| `intent_planner` | `discovery_planner` | `brain`, `discovery_planner` |
| `query_builder` | `discovery_planner` | `discovery_planner`, `intent_planner` |
| `signal_scout` | `discovery_planner` | `discovery_planner`, `query_builder` |
| `signal_scout_basics` | `discovery_planner` | `discovery_planner` |
| `intent_matcher` | `payment_decision` | `payment_decision`, `signal_scout` |
| `source_verifier` | `payment_decision` | `payment_decision`, `intent_matcher` |
| `value_allocator` | `payment_decision` | `payment_decision` |
| `trust_verifier` | `payment_decision` | `payment_decision` |
| `payment_decider` | `payment_decision` | `payment_decision` |
| `creator_attribution` | `settlement_memory` | `settlement_memory` |
| `advanced_evidence_evaluator` | `settlement_memory` | `settlement_memory` |
| `creator_payout_router` | `settlement_memory` | `settlement_memory` |

**x402 amount:** 0.000001 USDC per service

### Payload schemas

```typescript
// intent_planner
{ goal: string, budgetUsdc: number, routeTier?: "easy" | "normal" | "advanced" }

// query_builder
{ entity_terms: string[], negative_terms?: string[], routeTier?: string }

// signal_scout / signal_scout_basics
{ queries: string[], sourcePreferences?: string[], routeTier?: string }

// intent_matcher
{ intent: string, candidates: object[], routeTier?: string }

// source_verifier / value_allocator / trust_verifier
{ items: object[], routeTier?: string }

// payment_decider
{ evaluations: object[], routeTier?: string }

// creator_attribution
{ discoveryRunId: string, trace: object }

// advanced_evidence_evaluator
{ claims: object[], evidence: object[], routeTier?: string }

// creator_payout_router
{ attribution: object, creator_wallet: string | null, claim_status: string }
```

---

## 4. Route Preflight

Full pipeline with pre-authorized payment. Creates a discovery-run row and returns payment challenge.

```bash
curl -i -X POST https://paylabs.vercel.app/api/paylabs/discovery-runs/route-preflight \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "What sources discuss x402 micropayments?",
    "user_wallet": "0x03e99590874572c8b7c70237f62b10ad5a85132c"
  }'
```

| Field | Type | Required | Description |
|---|---|---|---|
| `goal` | string | ✅ | What the user is searching for |
| `user_wallet` | string | ✅ | Valid EVM address (`0x...`, 40 hex chars) |
| `budget_usdc` | number | ❌ | Budget cap (default: 0.01) |
| `route_tier` | `"auto"` \| `"easy"` \| `"normal"` \| `"advanced"` | ❌ | Pipeline tier (default: auto) |

**x402 amount:** routing fee (0.000001 USDC)

---

## Quick Reference

### Decode x402 payment challenge

```bash
# Get payment challenge JWT from response headers
curl -s -D /tmp/headers.txt -X POST https://paylabs.vercel.app/api/paylabs/brain/run \
  -H "Content-Type: application/json" \
  -d '{"userGoal":"test","routeTier":"normal","discoveryRunId":"test"}' > /dev/null

# Extract and decode
TOKEN=$(grep -i 'payment-required\|x-payment-required' /tmp/headers.txt | sed 's/.*: //' | tr -d '\r\n')
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

**Decoded challenge example:**
```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:5042002",
    "asset": "0x3600000000000000000000000000000000000000",
    "amount": "3",
    "payTo": "0x03e99590874572c8b7c70237f62b10ad5a85132c",
    "maxTimeoutSeconds": 604900,
    "extra": {
      "name": "GatewayWalletBatched",
      "version": "1",
      "verifyingContract": "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
    }
  }],
  "resource": {
    "url": "https://paylabs.vercel.app/api/paylabs/brain/run",
    "description": "PayLabs agent capability service"
  }
}
```

### Error responses

| HTTP | Meaning |
|---|---|
| `400` | Invalid input (bad names, missing fields, schema validation failure) |
| `402` | Payment required — x402 challenge in headers |
| `403` | Edge not allowed (buyerAgentName not in allowlist) |

---

## Notes

- **Network:** All payments on Arc testnet (`eip155:5042002`)
- **Stablecoin:** USDC (`0x3600000000000000000000000000000000000000`)
- **Payment method:** Circle Gateway Wallet Batched
- **Validation happens before x402 gate** — bad payloads get 400, never 402 (fail-fast, no charge for invalid requests)
