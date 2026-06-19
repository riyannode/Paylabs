/**
 * PayLabs Tutor LLM Factory
 *
 * Returns a ChatOpenAI instance configured for the tutor workflow.
 * API key resolution: PAYLABS_OPENAI_API_KEY → OPENAI_API_KEY
 * If PAYLABS_LLM_REQUIRED=true and no key, throws a clear server error.
 * No secrets printed.
 */

import { ChatOpenAI } from "@langchain/openai";

let cachedModel: ChatOpenAI | null = null;
let cacheChecked = false;
let cachedModelName = "";

export function getTutorModel(): ChatOpenAI | null {
  if (cacheChecked) return cachedModel;
  cacheChecked = true;

  const apiKey = process.env.PAYLABS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const llmRequired = process.env.PAYLABS_LLM_REQUIRED === "true";

  if (!apiKey) {
    if (llmRequired) {
      throw new Error(
        "PAYLABS_LLM_REQUIRED=true but no API key found. " +
        "Set PAYLABS_OPENAI_API_KEY or OPENAI_API_KEY."
      );
    }
    cachedModel = null;
    return null;
  }

  cachedModelName = process.env.PAYLABS_TUTOR_MODEL || "gpt-4o-mini";

  cachedModel = new ChatOpenAI({
    model: cachedModelName,
    apiKey,
    temperature: 0,
    maxTokens: 2048,
  });

  return cachedModel;
}

export function getTutorModelName(): string {
  if (cachedModelName) return cachedModelName;
  return process.env.PAYLABS_TUTOR_MODEL || "gpt-4o-mini";
}

export function isLlmRequired(): boolean {
  return process.env.PAYLABS_LLM_REQUIRED === "true";
}
