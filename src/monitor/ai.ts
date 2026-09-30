import Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "pino";
import {
  AI_SYSTEM_PROMPT,
  aiUserMessage,
  fallbackSummary,
  languageViolations,
  type EvidencePacket,
} from "./evidence.js";

export const AI_MODEL = "claude-opus-5";
const AI_TIMEOUT_MS = 20_000;

export interface SummaryResult {
  status: "generated" | "fallback";
  text: string;
  model: string | null;
  /** Why the fallback was used, when it was. */
  reason: string | null;
}

/**
 * Writes the case summary with Claude, grounded in the evidence packet. Any failure (no key,
 * timeout, API error, refusal, or wording that fails the language check) returns the
 * deterministic fallback instead, so a case is always reviewable.
 */
export async function summarizeCase(
  packet: EvidencePacket,
  apiKey: string | null,
  logger: Logger,
): Promise<SummaryResult> {
  const fallback = (reason: string): SummaryResult => ({
    status: "fallback",
    text: fallbackSummary(packet),
    model: null,
    reason,
  });

  if (!apiKey) return fallback("ai_not_configured");

  const client = new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 1 });
  try {
    const response = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      // If a safety classifier declines, the API retries on Anthropic's recommended model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // A short, grounded summary: low effort keeps the alert fast without changing the facts.
      output_config: { effort: "low" },
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: aiUserMessage(packet) }],
    });

    if (response.stop_reason === "refusal") return fallback("ai_refused");

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return fallback("ai_empty_response");

    const violations = languageViolations(text);
    if (violations.length) {
      logger.warn({ case_id: packet.case_id, violations }, "AI summary failed the language check");
      return fallback("ai_language_check_failed");
    }
    return { status: "generated", text, model: response.model, reason: null };
  } catch (err) {
    const reason =
      err instanceof Anthropic.APIConnectionTimeoutError
        ? "ai_timeout"
        : err instanceof Anthropic.RateLimitError
          ? "ai_rate_limited"
          : err instanceof Anthropic.AuthenticationError
            ? "ai_auth_failed"
            : err instanceof Anthropic.APIError
              ? `ai_error_${err.status ?? "unknown"}`
              : "ai_unreachable";
    logger.warn(
      { case_id: packet.case_id, reason },
      "AI summary failed, using the fallback template",
    );
    return fallback(reason);
  }
}
