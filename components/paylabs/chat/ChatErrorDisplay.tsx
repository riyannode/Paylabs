export function ChatErrorDisplay({ error }: { error: string }) {
  return <div className="pl-error-msg">{error || "Something went wrong."}</div>;
}
