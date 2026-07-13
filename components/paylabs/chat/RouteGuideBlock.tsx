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
              <span>Best for: Fast explanations and simple questions</span>
              <span className="pl-guide-example">Explain a concept or summarize a topic using trusted sources.</span>
            </div>
            <button className="pl-guide-use" onClick={() => onUsePrompt("Explain a concept or summarize a topic using trusted sources.")}>Use</button>
          </div>
          <div className="pl-guide-row">
            <div className="pl-guide-info">
              <b>Standard research</b>
              <span>Best for: Verification and comparison</span>
              <span className="pl-guide-example">Compare options, verify claims, and answer with multiple supporting sources.</span>
            </div>
            <button className="pl-guide-use" onClick={() => onUsePrompt("Compare options, verify claims, and answer with multiple supporting sources.")}>Use</button>
          </div>
          <div className="pl-guide-row">
            <div className="pl-guide-info">
              <b>Deep research</b>
              <span>Best for: Comprehensive analysis</span>
              <span className="pl-guide-example">Conduct in-depth multi-source research with detailed comparisons, citations, and recent developments.</span>
            </div>
            <button className="pl-guide-use" onClick={() => onUsePrompt("Conduct in-depth multi-source research with detailed comparisons, citations, and recent developments.")}>Use</button>
          </div>
        </div>
      )}
    </div>
  );
}
