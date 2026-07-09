"use client";

import { useState } from "react";
import { usdc } from "@/lib/utils";
import BatchResolverLink from "@/components/paylabs/BatchResolverLink";

interface PaymentRow {
  id: string;
  discovery_run_id: string | null;
  buyer: string;
  seller: string;
  node_type: string | null;
  status: string;
  amount_usdc: number;
  tx_hash: string | null;
  explorer_url: string | null;
  batch_tx_hash: string | null;
  batch_explorer_url: string | null;
  error: string | null;
  created_at: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function labelNode(addr: string): string {
  if (!addr) return "—";
  if (addr.toLowerCase() === "0x0000000000000000000000000000000000000000") return "Platform";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function actorKindLabel(addr: string, row: PaymentRow, side: "buyer" | "seller"): string {
  const lower = addr?.toLowerCase();
  if (lower === "0x0000000000000000000000000000000000000000") return "Platform";
  if (side === "buyer" && lower === row.buyer?.toLowerCase()) {
    if (row.node_type?.includes("Platform")) return "Platform";
  }
  return "";
}

function arrowFlowLabel(row: PaymentRow): string {
  if (row.node_type?.includes("Platform")) return "AI Run Payment";
  if (row.node_type?.includes("Route")) return "Route Check";
  return "";
}

const INITIAL_COUNT = 25;

export default function PaymentTable({ rows }: { rows: PaymentRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const visibleRows = showAll ? rows : rows.slice(0, INITIAL_COUNT);
  const hasMore = rows.length > INITIAL_COUNT;

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Buyer</th>
            <th></th>
            <th>Seller</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Payment Visibility</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((r) => (
            <tr key={r.id}>
              <td className="muted">{timeAgo(r.created_at)}</td>
              <td>
                <div className="data-mono" style={{ fontSize: 12 }}>
                  {labelNode(r.buyer)}
                </div>
                {actorKindLabel(r.buyer, r, "buyer") && (
                  <div className="muted" style={{ fontSize: 10 }}>
                    ({actorKindLabel(r.buyer, r, "buyer")})
                  </div>
                )}
              </td>
              <td style={{ textAlign: "center", padding: "0 4px" }}>
                <div className="data-mono" style={{ fontSize: 12, color: "var(--muted, #888)" }}>→</div>
                {arrowFlowLabel(r) && (
                  <div className="muted" style={{ fontSize: 9 }}>
                    ({arrowFlowLabel(r)})
                  </div>
                )}
              </td>
              <td>
                <div className="data-mono" style={{ fontSize: 12 }}>
                  {labelNode(r.seller)}
                </div>
                {actorKindLabel(r.seller, r, "seller") && (
                  <div className="muted" style={{ fontSize: 10 }}>
                    ({actorKindLabel(r.seller, r, "seller")})
                  </div>
                )}
              </td>
              <td className="data-mono">{usdc(r.amount_usdc)}</td>
              <td>
                <span className={`badge ${
                  r.status === "paid" ? "badge-success" :
                  r.status === "failed" ? "badge-danger" : "badge-warning"
                }`}>
                  {r.status}
                </span>
              </td>
              <td>
                <BatchResolverLink
                  runId={r.discovery_run_id || ""}
                  initialBatchExplorerUrl={r.batch_explorer_url}
                  initialBatchTxHash={r.batch_tx_hash}
                  directExplorerUrl={r.explorer_url}
                  directTxHash={r.tx_hash}
                />
              </td>
              <td className="muted" style={{ fontSize: 10, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.error || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hasMore && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <button
            onClick={() => setShowAll(!showAll)}
            style={{
              padding: "8px 20px",
              borderRadius: 999,
              border: "1px solid var(--border, #e5e7eb)",
              background: "var(--bg, #fff)",
              color: "var(--muted, #6b7280)",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 150ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--accent, #6366f1)";
              e.currentTarget.style.color = "var(--accent, #6366f1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border, #e5e7eb)";
              e.currentTarget.style.color = "var(--muted, #6b7280)";
            }}
          >
            {showAll ? `Show less ↑` : `Show ${rows.length - INITIAL_COUNT} more ↓`}
          </button>
        </div>
      )}
    </div>
  );
}
