import type { Logger } from "pino";
import {
  AI_SYSTEM_PROMPT,
  aiUserMessage,
  fallbackSummary,
  languageViolations,
  type EvidencePacket,
} from "./evidence.js";

/** Free OpenRouter models, tried in order. Override with OPENROUTER_MODELS (comma-separated). */
export const DEFAULT_OPENROUTER_MODELS = [
  "google/gemma-4-31b-it:free",
  "qwen/qwen3.8-27b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-26b-a4b-it:free",
  "openrouter/free",
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Per-model limit, and the whole budget across models, so an alert is never held up for long. */
const MODEL_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 45_000;

export interface AiConfig {
  apiKey: string | null;
  models: string[];
  /** Sent to OpenRouter as the app's referer, for its usage dashboard. */
  appUrl: string | null;
}

export interface SummaryResult {
  status: "generated" | "fallback";
  text: string;
  model: string | null;
  /** Why the fallback was used, when it was. */
  reason: string | null;
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  error?: { message?: string; code?: number | string };
}

/** Some free models think out loud inside <think> tags; only the answer is kept. */
function cleanText(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Writes the case summary with a free model on OpenRouter, grounded in the evidence packet.
 * Models are tried in order; any failure (no key, timeout, rate limit, empty answer, or wording
 * that fails the language check) moves to the next, and if none succeeds the deterministic
 * template is used, so a case is always reviewable.
 */
export async function summarizeCase(
  packet: EvidencePacket,
  ai: AiConfig,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<SummaryResult> {
  const fallback = (reason: string): SummaryResult => ({
    status: "fallback",
    text: fallbackSummary(packet),
    model: null,
    reason,
  });
  if (!ai.apiKey) return fallback("ai_not_configured");

  const started = Date.now();
  let lastReason = "ai_no_models";
  for (const model of ai.models) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (remaining <= 2000) {
      lastReason = "ai_timeout";
      break;
    }
    try {
      const res = await fetchImpl(OPENROUTER_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${ai.apiKey}`,
          "content-type": "application/json",
          ...(ai.appUrl ? { "http-referer": ai.appUrl } : {}),
          "x-title": "Group 13 Integrity Monitor",
        },
        body: JSON.stringify({
          model,
          // Free models all reason before answering; keep that short and out of the reply.
          max_tokens: 2000,
          temperature: 0.2,
          reasoning: { effort: "low", exclude: true },
          messages: [
            { role: "system", content: AI_SYSTEM_PROMPT },
            { role: "user", content: aiUserMessage(packet) },
          ],
        }),
        signal: AbortSignal.timeout(Math.min(MODEL_TIMEOUT_MS, remaining)),
      });
      const body = (await res.json().catch(() => ({}))) as ChatResponse;
      if (!res.ok || body.error) {
        lastReason =
          res.status === 429
            ? "ai_rate_limited"
            : res.status === 401
              ? "ai_auth_failed"
              : `ai_error_${res.status}`;
        logger.warn(
          { case_id: packet.case_id, model, status: res.status },
          "AI model unavailable, trying the next",
        );
        if (res.status === 401) break;
        continue;
      }
      const text = cleanText(body.choices?.[0]?.message?.content ?? "");
      if (!text) {
        lastReason = "ai_empty_response";
        continue;
      }
      const violations = languageViolations(text);
      if (violations.length) {
        lastReason = "ai_language_check_failed";
        logger.warn(
          { case_id: packet.case_id, model, violations },
          "AI summary failed the language check",
        );
        continue;
      }
      return { status: "generated", text, model: body.model ?? model, reason: null };
    } catch (err) {
      const e = err as Error;
      lastReason =
        e.name === "TimeoutError" || e.name === "AbortError" ? "ai_timeout" : "ai_unreachable";
      logger.warn(
        { case_id: packet.case_id, model, reason: lastReason },
        "AI model failed, trying the next",
      );
    }
  }
  logger.warn(
    { case_id: packet.case_id, reason: lastReason },
    "No AI model produced a usable summary, using the template",
  );
  return fallback(lastReason);
}
