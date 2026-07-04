import Link from "next/link";

export const metadata = {
  title: "PayLabs - AI search that pays creators",
  description:
    "AI-powered source discovery with automatic creator payments. Researchers get verified sources. Creators get paid.",
};

export default function LandingPage() {
  return (
    <div className="landing">
      {/* ── Nav ── */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <Link href="/" className="landing-logo" aria-label="PayLabs home">
            <img
              src="/brand/paylabs-logo-wordmark.png"
              alt="PayLabs"
              className="landing-logo-img"
              draggable={false}
            />
          </Link>
          <Link href="/chat" className="landing-nav-cta">
            Open App
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="landing-hero">
        <div className="landing-hero-content">
          <p className="landing-eyebrow">AI Search x Creator Payments</p>
          <h1 className="landing-headline">
            AI search that
            <br />
            pays creators.
          </h1>
          <p className="landing-sub">
            Ask anything. Get source-backed answers from live feeds. Every query
            automatically pays the creators behind the sources.
          </p>
          <div className="landing-cta-row">
            <Link href="/chat" className="landing-btn-primary">
              Start searching
            </Link>
            <a href="#how-it-works" className="landing-btn-ghost">
              How it works
            </a>
          </div>
        </div>

        {/* Hero visual - animated flow diagram */}
        <div className="landing-hero-visual">
          <div className="landing-flow">
            <div className="landing-flow-node landing-flow-query">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <span>Your question</span>
            </div>
            <div className="landing-flow-arrow">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </div>
            <div className="landing-flow-node landing-flow-ai">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22" />
                <path d="M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93" />
                <path d="M8.56 13.68 3 17l5 3 2.45-4.9" />
                <path d="M15.44 13.68 21 17l-5 3-2.45-4.9" />
              </svg>
              <span>PayLabs Brain</span>
            </div>
            <div className="landing-flow-arrow">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </div>
            <div className="landing-flow-node landing-flow-sources">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
              </svg>
              <span>Verified sources</span>
            </div>
            <div className="landing-flow-arrow">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </div>
            <div className="landing-flow-node landing-flow-creator">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="5" />
                <path d="M20 21a8 8 0 0 0-16 0" />
              </svg>
              <span>Creator paid</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Value Props ── */}
      <section className="landing-props">
        <div className="landing-props-grid">
          <div className="landing-prop">
            <div className="landing-prop-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <h3 className="landing-prop-title">Creators earn per query</h3>
            <p className="landing-prop-desc">
              Every time your content is cited in an AI search, you receive
              automatic micropayments. No ads, no subscriptions.
            </p>
          </div>
          <div className="landing-prop">
            <div className="landing-prop-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 12l2 2 4-4" />
                <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
              </svg>
            </div>
            <h3 className="landing-prop-title">Source-backed answers</h3>
            <p className="landing-prop-desc">
              Every answer links to live, verified sources from RSS feeds and
              curated repositories. No hallucinations.
            </p>
          </div>
          <div className="landing-prop">
            <div className="landing-prop-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            </div>
            <h3 className="landing-prop-title">Instant x402 payments</h3>
            <p className="landing-prop-desc">
              Powered by Circle&apos;s x402 protocol. USDC micropayments settle
              in seconds, across chains.
            </p>
          </div>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section className="landing-how" id="how-it-works">
        <h2 className="landing-section-title">How it works</h2>
        <div className="landing-steps">
          <div className="landing-step">
            <span className="landing-step-num">1</span>
            <h3>Ask a question</h3>
            <p>Type any research query. PayLabs Brain classifies complexity and selects the right pipeline.</p>
          </div>
          <div className="landing-step">
            <span className="landing-step-num">2</span>
            <h3>Pay a tiny fee</h3>
            <p>A small USDC amount covers AI processing, source retrieval, and creator payouts. Typically under $0.001.</p>
          </div>
          <div className="landing-step">
            <span className="landing-step-num">3</span>
            <h3>Get verified results</h3>
            <p>Receive source-backed answers with direct links. Creators get paid automatically.</p>
          </div>
        </div>
      </section>

      {/* ── For Creators & Researchers ── */}
      <section className="landing-audiences">
        <div className="landing-audience-grid">
          <div className="landing-audience-card landing-audience-creators">
            <h3>For Creators</h3>
            <p>
              Register your RSS feed or website. When AI researchers cite your
              content, you earn USDC directly to your wallet.
            </p>
            <Link href="/creator-profile" className="landing-audience-link">
              Register as creator
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </Link>
          </div>
          <div className="landing-audience-card landing-audience-researchers">
            <h3>For Researchers</h3>
            <p>
              Get source-backed, real-time answers. Every claim links to its
              origin. Trust the search, verify the source.
            </p>
            <Link href="/chat" className="landing-audience-link">
              Start researching
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="landing-final">
        <h2>Search. Verify. Pay creators.</h2>
        <Link href="/chat" className="landing-btn-primary">
          Open PayLabs
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <img
            src="/brand/paylabs-logo-wordmark.png"
            alt="PayLabs"
            className="landing-footer-logo"
            draggable={false}
          />
          <p className="landing-footer-copy">
            Built for the Lepton Agents Hackathon. Powered by Circle x402.
          </p>
        </div>
      </footer>
    </div>
  );
}
