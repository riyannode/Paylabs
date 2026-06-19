interface EmptyStateProps {
  message?: string;
}

export default function EmptyState({ message = "No records yet." }: EmptyStateProps) {
  return (
    <div style={{
      textAlign: "center",
      padding: "32px 16px",
      color: "var(--muted)",
      fontSize: 14,
    }}>
      {message}
    </div>
  );
}
