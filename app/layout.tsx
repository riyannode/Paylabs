import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayLabs — Pay only for what you learn",
  description:
    "AI micro-learning buyer. User sets goal + budget, AI Tutor picks source-backed lessons, pays via x402 on Arc testnet.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh" }}>
        <nav
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "1rem 2rem",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <a href="/" style={{ fontWeight: 700, fontSize: "1.25rem", color: "var(--foreground)" }}>
            PayLabs
          </a>
          <div style={{ display: "flex", gap: "1.5rem" }}>
            <a href="/learn">Lessons</a>
            <a href="/tutor">AI Tutor</a>
            <a href="/receipts">Receipts</a>
          </div>
        </nav>
        <main style={{ maxWidth: 960, margin: "0 auto", padding: "2rem" }}>
          {children}
        </main>
      </body>
    </html>
  );
}
