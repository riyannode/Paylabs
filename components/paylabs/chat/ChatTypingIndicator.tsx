export function ChatTypingIndicator({ signingPhase }: { signingPhase: string | null }) {
  return (
    <div className="pl-typing-row">
      <div className="pl-typing-dot" />
      <div className="pl-typing-dot" />
      <div className="pl-typing-dot" />
      {signingPhase && <span className="pl-signing-phase">{signingPhase}</span>}
    </div>
  );
}
