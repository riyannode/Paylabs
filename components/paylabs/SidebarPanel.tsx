"use client";

import PayLabsNavLinks from "./PayLabsNavLinks";
import PayLabsBrandLogo from "./PayLabsBrandLogo";

type RecentChatItem = {
  id: string;
  content: string;
  createdAt: number;
  runId?: string | null;
};

type Analytics = {
  uniqueUsers: number;
  active24h: number;
  active7d: number;
};

type Props = {
  analytics: Analytics;
  recentChats?: RecentChatItem[];
  onUseRecentChat?: (chat: RecentChatItem) => void;
};

function formatChatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SidebarPanel({
  analytics,
  recentChats,
  onUseRecentChat,
}: Props) {
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

      {recentChats && recentChats.length > 0 && (
        <section className="pl-side-card">
          <div className="pl-side-title">Recent Chats</div>
          <div className="pl-recent-chats-list">
            {recentChats
              .slice()
              .reverse()
              .map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  className="pl-recent-chat-item"
                  onClick={() => onUseRecentChat?.(chat)}
                  title={chat.content}
                >
                  <span className="pl-recent-chat-text">
                    {chat.content.length > 40
                      ? `${chat.content.slice(0, 40)}…`
                      : chat.content}
                  </span>
                  <span className="pl-recent-chat-meta">
                    {chat.runId ? "View receipt" : formatChatTime(chat.createdAt)}
                  </span>
                </button>
              ))}
          </div>
        </section>
      )}
    </aside>
  );
}
