import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayLabs — AI source-feed learning paths with creator citation tolls",
  description:
    "Ingests RSSHub/RSS feeds, turns feed items into source-backed learning cards, prepares citation/unlock payments for creators.",
};

const NAV_LINKS = [
  { href: "/sources", label: "Sources" },
  { href: "/tutor", label: "Tutor" },
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
