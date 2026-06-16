// OpenAI summary service
// Ranks and explains content sources after payment

import { config } from "../config.js";

export interface ContentRanking {
  url: string;
  title: string;
  relevanceScore: number;
  explanation: string;
}

export async function rankAndExplainSources(
  query: string,
  sources: Array<{ url: string; title: string; content: string }>
): Promise<ContentRanking[]> {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // Dynamic import to avoid loading OpenAI if not needed
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  const sourcesText = sources
    .map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.content.slice(0, 300)}`)
    .join("\n\n");

  const response = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: [
      {
        role: "system",
        content: `You are a content curator. Given a user query and search results, rank them by relevance and explain why each is worth paying $0.000001 to unlock. Return JSON array: [{"url": "...", "title": "...", "relevanceScore": 0-100, "explanation": "..."}]`,
      },
      {
        role: "user",
        content: `Query: ${query}\n\nSources:\n${sourcesText}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  try {
    const parsed = JSON.parse(content) as { rankings?: ContentRanking[] } | ContentRanking[];
    if (Array.isArray(parsed)) return parsed;
    return parsed.rankings ?? [];
  } catch {
    return [];
  }
}
