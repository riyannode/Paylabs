"use client";
import { useState } from "react";
import type { X402PaymentChallenge } from "@/types/paylabs";

interface Props {
  lessonId: string;
  lessonSlug: string;
  priceUsdc: number;
  challenge: X402PaymentChallenge;
}

export default function UnlockButton({ lessonId, lessonSlug, priceUsdc, challenge }: Props) {
  const [status, setStatus] = useState<"idle" | "paying" | "unlocked" | "error">("idle");
  const [error, setError] = useState("");

  async function handleUnlock() {
    setStatus("paying");
    setError("");

    try {
      // Request the content endpoint - server will return 402 with challenge
      const res = await fetch(`/api/paylabs/lessons/${lessonId}/content`, {
        method: "GET",
        headers: { "x-paylabs-wallet": "demo-user" },
      });

      if (res.status === 402) {
        // In a real flow, the wallet would sign the challenge and retry.
        // For MVP demo, we simulate the payment by posting to the unlock endpoint.
        const payRes = await fetch(`/api/paylabs/lessons/${lessonId}/content`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_wallet: "demo-user",
            payment_id: crypto.randomUUID(),
            payment_ref: `x402-${Date.now()}`,
            amount_usdc: priceUsdc,
          }),
        });

        if (payRes.ok) {
          setStatus("unlocked");
          window.location.reload();
        } else {
          const data = await payRes.json();
          setError(data.error || "Payment failed");
          setStatus("error");
        }
      } else if (res.ok) {
        setStatus("unlocked");
        window.location.reload();
      }
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }

  return (
    <div>
      <button
        onClick={handleUnlock}
        disabled={status === "paying" || status === "unlocked"}
        className="btn btn-primary"
        style={{ fontSize: "1rem", padding: "0.75rem 2rem" }}
      >
        {status === "idle" && `Unlock for ${priceUsdc} USDC`}
        {status === "paying" && "Processing payment..."}
        {status === "unlocked" && "Unlocked!"}
        {status === "error" && "Retry payment"}
      </button>
      {error && <p style={{ color: "#ef4444", fontSize: "0.875rem", marginTop: "0.5rem" }}>{error}</p>}
    </div>
  );
}
