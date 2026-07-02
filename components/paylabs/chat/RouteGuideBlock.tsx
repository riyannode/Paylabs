"use client";

import { useState } from "react";

type RouteGuideBlockProps = {
  onUsePrompt: (prompt: string) => void;
};

export function RouteGuideBlock({ onUsePrompt }: RouteGuideBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="pl-guide-block">
      <button
        className="pl-guide-toggle"
        onClick={() => setOpen(!open)}
      >
        <span>Route guide — Brain auto routes by task complexity</span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="pl-guide-rows">
          <div className="pl-guide-row">
            <div className="pl-guide-info">
              <b>Quick answer</b>
              <span>Best for: Explain, define, summarize</span>
              <span className="pl-guide-example">Explain Arc x402 simply using source-backed info.</span>
            </div>
            <button className="pl-guide-use" onClick={() => onUsePrompt("Explain Arc x402 simply using source-backed info.")}>Use</button>
          </div>
          <div className="pl-guide-row">
            <div className="pl-guide-info">
              <b>Standard research</b>
              <span>Best for: Compare, verify, fact-check</span>
              <span className="pl-guide-example">Compare Arc x402 and Circle Gateway and verify the main claims.</span>
            </div>
            <button className="pl-guide-use" onClick={() => onUsePrompt("Compare Arc x402 and Circle Gateway and verify the main claims.")}>Use</button>
          </div>
          <div className="pl-guide-row">
            <div className="pl-guide-info">
              <b>Deep research</b>
              <span>Best for: Multi-source, current, attribution</span>
              <span className="pl-guide-example">What are the latest developments in open source AI agent frameworks, compare the strongest projects, verify with multiple current sources, and show which sources influenced the answer?</span>
            </div>
            <button className="pl-guide-use" onClick={() => onUsePrompt("What are the latest developments in open source AI agent frameworks, compare the strongest projects, verify with multiple current sources, and show which sources influenced the answer?")}>Use</button>
          </div>
        </div>
      )}
    </div>
  );
}
