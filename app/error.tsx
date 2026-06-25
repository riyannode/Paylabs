"use client";

export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "60vh", gap: 16, padding: 32,
      fontFamily: "system-ui, sans-serif", textAlign: "center",
    }}>
      <div style={{ fontSize: 40 }}>⚠️</div>
      <h2 style={{ margin: 0, fontSize: 20 }}>Page error</h2>
      <p style={{ margin: 0, fontSize: 14, opacity: 0.7, maxWidth: 400 }}>
        {error.message || "Something went wrong loading this page."}
      </p>
      <button
        onClick={reset}
        style={{
          marginTop: 8, padding: "8px 24px", borderRadius: 8, border: "1px solid #333",
          background: "#111", color: "#fff", cursor: "pointer", fontSize: 14,
        }}
      >
        Try again
      </button>
    </div>
  );
}
