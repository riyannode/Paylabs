"use client";

export function PaymentEffect({ kind }: { kind: "settled" | "failed" | "success" }) {
  return <div className={`po-effect po-effect-${kind}`} aria-hidden="true" />;
}
