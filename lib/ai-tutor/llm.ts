/**
 * PayLabs Tutor LLM Factory
 *
 * Returns a ChatOpenAI instance configured for the tutor workflow.
 * Returns null if OPENAI_API_KEY is missing — agents fall back to deterministic logic.
 * No secrets are printed.
 */

import { ChatOpenAI } from "@langchain/openai";

let cachedModel: ChatOpenAI | null = null;
let cacheChecked = false;

export function getTutorModel(): ChatOpenAI | null {
  if (cacheChecked) return cachedModel;
  cacheChecked = true;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    cachedModel = null;
    return null;
  }

  const modelName = process.env.PAYLABS_TUTOR_MODEL || "gpt-4o-mini";

  cachedModel = new ChatOpenAI({
    model: modelName,
    temperature: 0,
    maxTokens: 2048,
    // apiKey read from env automatically by ChatOpenAI
  });

  return cachedModel;
}

export function getTutorModelName(): string {
  return process.env.PAYLABS_TUTOR_MODEL || "gpt-4o-mini";
}
