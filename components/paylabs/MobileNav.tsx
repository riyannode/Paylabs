"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PayLabsNavLinks from "./PayLabsNavLinks";

type Props = {
  /** Called when user wants to open the wallet modal. */
  onOpenWallet?: () => void;
  /**
   * When true, adds a body class that pushes .container.pl-compact-root
   * down so sub-page content isn't hidden under the fixed topbar.
   * The chat page uses .pl-app padding-top instead, so it does NOT
   * set this flag.
   */
  applyBodyOffset?: boolean;
};

export default function MobileNav({ onOpenWallet, applyBodyOffset = false }: Props) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Add body class for sub-page top padding (only when requested)
  useEffect(() => {
    if (!applyBodyOffset) return;
    const mq = window.matchMedia("(max-width: 960px)");
    function apply() {
      if (mq.matches) {
        document.body.classList.add("pl-mobile-has-topbar");
      } else {
        document.body.classList.remove("pl-mobile-has-topbar");
      }
    }
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.body.classList.remove("pl-mobile-has-topbar");
    };
  }, [applyBodyOffset]);

  // Close on Escape key
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeDrawer();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <>
      {/* ── Mobile top bar ── */}
      <header className="pl-mobile-topbar">
        <button
          type="button"
          className="pl-mobile-hamburger"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
        >
          {/* Hamburger icon — 3 bars */}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span className="pl-mobile-brand">PayLabs</span>
        <div className="pl-mobile-topbar-spacer" />
      </header>

      {/* ── Drawer overlay + panel ── */}
      {drawerOpen && (
        <div className="pl-mobile-drawer-root">
          <div
            className="pl-mobile-backdrop"
            onClick={closeDrawer}
            aria-hidden="true"
          />
          <aside
            ref={drawerRef}
            className="pl-mobile-drawer"
            role="dialog"
            aria-label="Mobile navigation"
          >
            <div className="pl-mobile-drawer-header">
              <span className="pl-brand">PayLabs</span>
              <button
                type="button"
                className="pl-mobile-close"
                onClick={closeDrawer}
                aria-label="Close navigation"
              >
                {/* X icon */}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <PayLabsNavLinks onNavigate={closeDrawer} />
          </aside>
        </div>
      )}
    </>
  );
}
