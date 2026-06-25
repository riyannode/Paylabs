export default function Loading() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100vh", gap: 16,
      fontFamily: "system-ui, sans-serif", textAlign: "center",
    }}>
      <div style={{
        width: 32, height: 32, border: "3px solid #333",
        borderTopColor: "#fff", borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }} />
      <p style={{ margin: 0, fontSize: 14, opacity: 0.6 }}>Loading PayLabs…</p>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}
