import { ReactNode } from "react";

interface SimpleTableProps {
  headers: string[];
  rows: ReactNode[][];
  mono?: boolean;
}

export default function SimpleTable({ headers, rows, mono }: SimpleTableProps) {
  if (rows.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "24px 0", color: "var(--muted)", fontSize: 14 }}>
        No records yet.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={mono ? "data-mono" : undefined} style={{ fontSize: 13 }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
