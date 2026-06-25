"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
        <main style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", minHeight: "100vh", gap: 16, padding: 32, textAlign: "center",
        }}>
          <div style={{ fontSize: 48 }}>💥</div>
          <h1 style={{ margin: 0, fontSize: 24 }}>PayLabs ran into an error</h1>
          <p style={{ margin: 0, fontSize: 14, opacity: 0.7, maxWidth: 500 }}>
            {error.message || "An unexpected error occurred during page load."}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 12, padding: "10px 32px", borderRadius: 8, border: "1px solid #333",
              background: "#111", color: "#fff", cursor: "pointer", fontSize: 14,
            }}
          >
            Reload page
          </button>
        </main>
      </body>
    </html>
  );
}
