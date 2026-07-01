"use client";

import { usePathname } from "next/navigation";
import Image from "next/image";

/** Shared header for all PayLabs pages — design refresh v1. */
export default function PageHeader() {
  const pathname = usePathname();

  const links = [
    { label: "Search", href: "/" },
    { label: "Sources", href: "/source" },
    { label: "Creator", href: "/creator-dashboard" },
    { label: "Explorer", href: "/explorer" },
    { label: "Payment Visibility", href: "/receipts" },
  ];

  return (
    <header className="pl-header">
      <a href="/" className="pl-header-logo">
        <Image
          src="/paylabs-logo.png"
          alt="PayLabs"
          width={28}
          height={28}
          style={{ borderRadius: 6 }}
          priority
        />
        <span>PayLabs</span>
      </a>
      <nav className="pl-header-nav">
        {links.map((link) => {
          const isActive =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href);
          return (
            <a
              key={link.href}
              href={link.href}
              className={isActive ? "active" : ""}
            >
              {link.label}
            </a>
          );
        })}
        <a href="/creator-profile" className="pl-header-cta">
          Register as Creator
        </a>
      </nav>
      <button
        type="button"
        className="pl-mobile-hamburger"
        aria-label="Open navigation"
        onClick={() => {
          document.querySelector(".pl-header-nav")?.classList.toggle("open");
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    </header>
  );
}
