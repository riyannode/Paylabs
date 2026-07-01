"use client";

import { usePathname } from "next/navigation";

/** Updated navigation items for PayLabs design refresh. */
export const NAV_ITEMS = [
  { label: "Search", href: "/" },
  { label: "Sources", href: "/source" },
  { label: "Creator", href: "/creator-dashboard" },
  { label: "Explorer", href: "/explorer" },
  { label: "Payment Visibility", href: "/receipts" },
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
