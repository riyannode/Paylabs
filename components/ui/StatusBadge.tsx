interface StatusBadgeProps {
  status: string;
}

const STATUS_MAP: Record<string, { className: string }> = {
  completed: { className: "badge-success" },
  pending: { className: "badge-warning" },
  failed: { className: "badge-danger" },
  proposed: { className: "badge-warning" },
  approved: { className: "badge-success" },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const match = STATUS_MAP[status.toLowerCase()] || { className: "badge-neutral" };
  return <span className={`badge ${match.className}`}>{status}</span>;
}
