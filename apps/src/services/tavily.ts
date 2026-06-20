// Tavily search service
// Web search for content discovery

import { config } from "../config.js";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export async function searchWithTavily(query: string): Promise<TavilyResult[]> {
  if (!config.tavilyApiKey) {
    throw new Error("TAVILY_API_KEY not configured");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: 5,
      include_answer: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status}`);
  }

  const data = await response.json() as { results: TavilyResult[] };
  return data.results ?? [];
}
