"use client";

type ChatInputPanelProps = {
  prompt: string;
  status: "idle" | "running" | "done" | "error";
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
};

export function ChatInputPanel({
  prompt,
  status,
  onPromptChange,
  onSubmit,
}: ChatInputPanelProps) {
  return (
    <div className="pl-chat-composer">
      <textarea
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        placeholder="Ask for a route, receipt, or source-backed payment…"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="pl-search-actions">
        <span className="pl-x402-badge">x402 protected</span>
        <button
          className="pl-run-btn"
          onClick={onSubmit}
          disabled={status === "running" || !prompt.trim()}
        >
          {status === "running" ? "…" : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>}
        </button>
      </div>
    </div>
  );
}
