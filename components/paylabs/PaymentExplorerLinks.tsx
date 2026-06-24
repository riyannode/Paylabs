"use client";

import { hrefFromTx } from "@/lib/paylabs/x402/payment-links";

type PaymentExplorerLinksProps = {
  directExplorerUrl?: string | null;
  directTxHash?: string | null;
  batchExplorerUrl?: string | null;
  batchTxHash?: string | null;
  className?: string;
};

/**
 * Render at most two safe payment explorer links:
 * - "x402 payment ↗" for the direct/single nanopayment tx
 * - "Batch payment ↗" for the resolved batch settlement tx
 *
 * Never renders settlement IDs, resolver URLs, or raw tx hashes.
 */
export default function PaymentExplorerLinks({
  directExplorerUrl,
  directTxHash,
  batchExplorerUrl,
  batchTxHash,
  className,
}: PaymentExplorerLinksProps) {
  const directHref = hrefFromTx(directExplorerUrl, directTxHash);
  const batchHref = hrefFromTx(batchExplorerUrl, batchTxHash);

  if (!directHref && !batchHref) return null;

  return (
    <div className={className ?? "pl-payment-links-inline"}>
      {directHref && (
        <a href={directHref} target="_blank" rel="noopener noreferrer">
          x402 payment ↗
        </a>
      )}
      {batchHref && (
        <a href={batchHref} target="_blank" rel="noopener noreferrer">
          Batch payment ↗
        </a>
      )}
    </div>
  );
}
