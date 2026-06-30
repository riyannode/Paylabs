"use client";

import MobileNav from "./MobileNav";

/**
 * Client wrapper that renders the mobile topbar + drawer.
 * Used by server-component sub-pages (explorer, receipts, source, etc.)
 * that don't have the .pl-app grid.
 */
export default function SubPageMobileNav() {
  return <MobileNav applyBodyOffset />;
}
