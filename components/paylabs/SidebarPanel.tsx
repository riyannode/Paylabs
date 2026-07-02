"use client";

import PayLabsNavLinks from "./PayLabsNavLinks";
import PayLabsBrandLogo from "./PayLabsBrandLogo";

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
};

type Props = {
  analytics: Analytics;
};

export default function SidebarPanel({ analytics }: Props) {
  return (
    <aside className="pl-sidebar">
      <PayLabsBrandLogo />

      <PayLabsNavLinks />

      <section className="pl-side-card">
        <div className="pl-side-title">User Analytics</div>
        <div className="pl-metrics">
          <div>
            <b>{analytics.uniqueUsers}</b>
            <span>Users</span>
          </div>
          <div>
            <b>{analytics.active24h}</b>
            <span>24h</span>
          </div>
          <div>
            <b>{analytics.active7d}</b>
            <span>7d</span>
          </div>
        </div>
      </section>
    </aside>
  );
}
