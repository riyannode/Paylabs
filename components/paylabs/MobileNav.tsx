"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PayLabsNavLinks from "./PayLabsNavLinks";
import PayLabsBrandLogo from "./PayLabsBrandLogo";

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
  const [isMobile, setIsMobile] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Track mobile breakpoint + body offset class + auto-close drawer on resize
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 960px)");

    function apply() {
      const mobile = mq.matches;
      setIsMobile(mobile);

      // Close drawer when viewport becomes desktop
      if (!mobile) {
        setDrawerOpen(false);
      }

      // Body offset class for sub-pages only
      if (applyBodyOffset && mobile) {
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

  // Lock body scroll when drawer is open (cleared automatically on unmount/close)
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
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <PayLabsBrandLogo compact className="pl-mobile-brand-logo" />

        <div className="pl-mobile-topbar-spacer" />
      </header>

      {/* ── Drawer overlay + panel (mobile only) ── */}
      {drawerOpen && isMobile && (
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
              <PayLabsBrandLogo className="pl-mobile-drawer-brand-logo" />

              <button
                type="button"
                className="pl-mobile-close"
                onClick={closeDrawer}
                aria-label="Close navigation"
              >
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
