"use client";
import { useState, useEffect } from "react";
import type { X402PaymentChallenge } from "@/types/paylabs";

interface Props {
  lessonId: string;
  lessonSlug: string;
  priceUsdc: number;
  challenge: X402PaymentChallenge;
}

type Status = "idle" | "connecting" | "requesting" | "signing" | "submitting" | "unlocked" | "error";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

export default function UnlockButton({ lessonId, priceUsdc, challenge }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [wallet, setWallet] = useState<string | null>(null);

  // Check if wallet already connected
  useEffect(() => {
    if (typeof window !== "undefined" && window.ethereum) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accounts: unknown) => {
          const addrs = accounts as string[];
          if (addrs?.length > 0) setWallet(addrs[0]);
        })
        .catch(() => {});
    }
  }, []);

  async function connectWallet(): Promise<string> {
    if (!window.ethereum) {
      throw new Error("No wallet found. Install MetaMask or another EVM wallet.");
    }
    const accounts = (await window.ethereum.request({
      method: "eth_requestAccounts",
    })) as string[];
    if (!accounts?.length) throw new Error("No accounts returned from wallet");
    setWallet(accounts[0]);
    return accounts[0];
  }

  async function handleUnlock() {
    setStatus("connecting");
    setError("");

    try {
      // 1. Connect wallet
      let userWallet = wallet;
      if (!userWallet) {
        userWallet = await connectWallet();
      }

      // 2. Check if already unlocked
      setStatus("requesting");
      const checkRes = await fetch(`/api/paylabs/lessons/${lessonId}/content`, {
        method: "GET",
        headers: { "x-paylabs-wallet": userWallet },
      });

      if (checkRes.ok) {
        // Already unlocked
        setStatus("unlocked");
        window.location.reload();
        return;
      }

      if (checkRes.status !== 402) {
        const data = await checkRes.json();
        throw new Error(data.error || "Unexpected response");
      }

      // 3. Got 402 challenge — sign TransferWithAuthorization with wallet
      setStatus("signing");

      const now = Math.floor(Date.now() / 1000);
      const validAfter = BigInt(now - 60); // valid from 1 minute ago
      const validBefore = BigInt(now + 300); // valid for 5 minutes
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const nonceHex = `0x${nonce}` as `0x${string}`;
      const valueBaseUnits = BigInt(Math.round(priceUsdc * 1_000_000));

      // EIP-712 typed data for TransferWithAuthorization
      const typedData = {
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        domain: challenge.eip712Domain,
        message: {
          from: userWallet,
          to: challenge.receiverAddress,
          value: valueBaseUnits.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce: nonceHex,
        },
      };

      // Sign via wallet
      const signature = (await window.ethereum!.request({
        method: "eth_signTypedData_v4",
        params: [userWallet, JSON.stringify(typedData)],
      })) as string;

      // 4. Submit signed authorization to server
      setStatus("submitting");
      const payRes = await fetch(`/api/paylabs/lessons/${lessonId}/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: userWallet,
          to: challenge.receiverAddress,
          value: valueBaseUnits.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce: nonceHex,
          signature,
        }),
      });

      if (payRes.ok) {
        setStatus("unlocked");
        window.location.reload();
      } else {
        const data = await payRes.json();
        throw new Error(data.error || "Payment verification failed");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus("error");
    }
  }

  const needsWallet = !wallet;

  return (
    <div>
      <button
        onClick={handleUnlock}
        disabled={status !== "idle" && status !== "error"}
        className="btn btn-primary"
        style={{ fontSize: "1rem", padding: "0.75rem 2rem" }}
      >
        {status === "idle" && needsWallet && "Connect Wallet to Unlock"}
        {status === "idle" && !needsWallet && `Sign & Pay ${priceUsdc} USDC`}
        {status === "connecting" && "Connecting wallet..."}
        {status === "requesting" && "Checking access..."}
        {status === "signing" && "Sign the authorization in your wallet..."}
        {status === "submitting" && "Verifying payment..."}
        {status === "unlocked" && "Unlocked!"}
        {status === "error" && "Retry"}
      </button>
      {wallet && (
        <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.5rem" }}>
          Wallet: {wallet.slice(0, 6)}...{wallet.slice(-4)}
        </p>
      )}
      {error && (
        <p style={{ color: "#ef4444", fontSize: "0.875rem", marginTop: "0.5rem" }}>
          {error}
        </p>
      )}
    </div>
  );
}
