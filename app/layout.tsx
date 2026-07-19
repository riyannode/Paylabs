import type { Metadata } from "next";
import "./globals.css";
import ErrorBoundary from "@/components/ErrorBoundary";
import VisitTracker from "@/components/paylabs/VisitTracker";
import "@/components/paylabs/office/paylabs-office.css";

export const metadata: Metadata = {
  title: "PayLabs — Source-backed AI search",
  description:
    "Turns RSSHub/RSS feeds into cited AI search sources, with x402 citation and unlock payments prepared for verified creators.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh" }}>
        <VisitTracker />
        <main className="container pl-compact-root">
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </main>
      </body>
    </html>
  );
}
