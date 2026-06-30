"use client";

import { usePathname } from "next/navigation";

/** Shared navigation items for PayLabs sidebar + mobile drawer. */
export const NAV_ITEMS = [
  { label: "Chat", href: "/" },
  { label: "Receipts", href: "/receipts" },
  { label: "Explorer", href: "/explorer" },
  { label: "Sources", href: "/source" },
  { label: "Creator Dashboard", href: "/creator-dashboard" },
  { label: "Creator Profile", href: "/creator-profile" },
] as const;

type Props = {
  /** CSS class applied to the wrapping nav element. */
  navClassName?: string;
  /** CSS class applied to each anchor. */
  linkClassName?: string;
  /** Called when a link is clicked (useful for closing a mobile drawer). */
  onNavigate?: () => void;
};

export default function PayLabsNavLinks({
  navClassName = "pl-nav",
  linkClassName,
  onNavigate,
}: Props) {
  const pathname = usePathname();

  return (
    <nav className={navClassName}>
      {NAV_ITEMS.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        const cls = [
          linkClassName,
          isActive ? "active" : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <a
            key={item.href}
            href={item.href}
            className={cls || undefined}
            onClick={onNavigate}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
