"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Invisible component that tracks page visits.
 * Sends POST /api/paylabs/analytics/visit on mount and route change.
 * No wallet, no email, no visitor ID sent — server reads cookie.
 */
export default function VisitTracker() {
  const pathname = usePathname();

  useEffect(() => {
    try {
      fetch("/api/paylabs/analytics/visit", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: pathname || "/",
          referrer: document.referrer || null,
        }),
      }).catch(() => {
        // Silent — tracking failure must never break the page
      });
    } catch {
      // Silent
    }
  }, [pathname]);

  return null;
}
