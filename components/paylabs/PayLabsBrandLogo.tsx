"use client";

type PayLabsBrandLogoProps = {
  compact?: boolean;
  className?: string;
};

export default function PayLabsBrandLogo({
  compact = false,
  className = "",
}: PayLabsBrandLogoProps) {
  return (
    <a
      href="/"
      className={[
        "pl-brand-logo",
        compact ? "pl-brand-logo-compact" : "",
        className,
      ].filter(Boolean).join(" ")}
      aria-label="PayLabs home"
    >
      <img
        src="/brand/paylabs-logo-wordmark.png"
        alt="PayLabs"
        className="pl-brand-logo-img"
        draggable={false}
      />
    </a>
  );
}
