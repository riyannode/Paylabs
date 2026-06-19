import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayLabs — AI learning paths with x402 payments",
  description:
    "Chat with the tutor, pay a tiny route toll, approve a path, unlock lessons. x402 payments on Arc testnet.",
};

const NAV_LINKS = [
  { href: "/tutor", label: "Tutor" },
  { href: "/learn", label: "Lessons" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/receipts", label: "Payments" },
];

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
            borderBottom: "1px solid var(--border)",
            background: "white",
            position: "sticky",
            top: 0,
            zIndex: 10,
          }}
        >
          <div
            className="container"
            style={{
              height: 56,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <a
              href="/"
              style={{
                fontWeight: 800,
                fontSize: 18,
                letterSpacing: "-0.03em",
                color: "var(--foreground)",
              }}
            >
              PayLabs
            </a>
            <div
              style={{
                display: "flex",
                gap: 20,
                fontSize: 14,
                color: "var(--muted)",
                overflowX: "auto",
              }}
            >
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  style={{ whiteSpace: "nowrap" }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </nav>
        <main
          className="container"
          style={{ paddingTop: 32, paddingBottom: 64 }}
        >
          {children}
        </main>
      </body>
    </html>
  );
}
