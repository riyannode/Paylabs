interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
}

export default function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>{label}</div>
      <div className="kpi" style={{ marginTop: 4 }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
