"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; errorMsg: string | null };

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMsg: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, errorMsg: error.message || "Something went wrong" };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to console in dev, could send to error tracking in prod
    console.error("[PayLabs ErrorBoundary]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMsg: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", minHeight: "300px", gap: 16, padding: 32,
          fontFamily: "system-ui, sans-serif", textAlign: "center",
        }}>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <h2 style={{ margin: 0, fontSize: 18 }}>Something went wrong</h2>
          <p style={{ margin: 0, fontSize: 14, opacity: 0.7, maxWidth: 400 }}>
            {this.state.errorMsg}
          </p>
          <button
            onClick={this.handleReset}
            style={{
              marginTop: 8, padding: "8px 24px", borderRadius: 8, border: "1px solid #333",
              background: "#111", color: "#fff", cursor: "pointer", fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
