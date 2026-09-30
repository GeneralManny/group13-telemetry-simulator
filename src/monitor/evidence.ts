import type { RuleHit } from "./engine/risk.js";
import { clockText } from "./engine/risk.js";

/**
 * The evidence packet is the only thing the AI summary, the Slack alert and the case page are
 * built from. Every statement they make must trace back to a field in here.
 */
export interface EvidencePacket {
  case_id: string;
  severity: string;
  score: number;
  peak_score: number;
  status: string;
  match: {
    match_id: string;
    tournament_id: string | null;
    simulator_run_id: string | null;
    match_clock_seconds: number;
    score: { team_blue: number; team_red: number };
  };
  subject:
    | { type: "player"; player_id: string; display_name: string; team_id: string }
    | { type: "market" };
  components: { performance: number; odds: number; cluster: number };
  rules: RuleHit[];
  window: { start: number | null; end: number | null };
  metrics_vs_baseline: {
    metric: string;
    baseline_mean: number;
    baseline_stddev: number;
    baseline_sample_size: number;
    window_average: number | null;
    deviation_sd: number | null;
  }[];
  odds_moves: {
    event_id: string;
    match_clock: number;
    movement_pct: number;
    shortened_team: string | null;
    from: unknown;
    to: unknown;
  }[];
  sample_events: {
    event_id: string;
    match_clock: number;
    event_type: string;
    metrics: Record<string, unknown>;
  }[];
  evidence_event_count: number;
  case_url: string | null;
}

/** Words that would turn a statistical signal into an accusation. Checked on every AI summary. */
const ACCUSATORY = [
  /\bcheat(ed|er|ers|ing)?\b/i,
  /\bmatch[- ]?fix(ed|ing|er)?\b/i,
  /\bfix(ed|ing)? the match\b/i,
  /\bguilt(y)?\b/i,
  /\brigged\b/i,
  /\bhack(ed|er|ing)?\b/i,
  /\baimbot\b/i,
  /\bwallhack\b/i,
  /\bthrew the (match|game|round)\b/i,
  /\bthrowing the (match|game|round)\b/i,
];

export function languageViolations(text: string): string[] {
  return ACCUSATORY.filter((re) => re.test(text)).map((re) => re.source);
}

function subjectLine(p: EvidencePacket): string {
  if (p.subject.type === "market") return "the match-winner betting market";
  const team = p.subject.team_id === "team_blue" ? "Team Blue" : "Team Red";
  return `${p.subject.display_name} (${p.subject.player_id}, ${team})`;
}

/**
 * Deterministic summary used when the AI service is unavailable, too slow, refuses, or produces
 * wording that fails the language check. Built only from packet fields, so it is always grounded.
 */
export function fallbackSummary(p: EvidencePacket): string {
  const lines = [
    `Case ${p.case_id}: ${p.severity.toUpperCase()} risk, score ${p.score} of 100, for ${subjectLine(p)} in match ${p.match.match_id}.`,
    "",
    "What was measured:",
    ...p.rules
      .filter((r) => r.points > 0)
      .map((r) => `- ${r.description} (${r.rule_id}, ${r.points} points)`),
    "",
    `Score breakdown: performance ${p.components.performance}, odds ${p.components.odds}, repeated signals ${p.components.cluster}.`,
    "",
    "These are statistical signals compared with the player's own history. They do not establish that any rule was broken. " +
      "Recommended next step: a tournament administrator reviews the evidence and chooses approve for investigation, dismiss, or escalate.",
  ];
  return lines.join("\n");
}

export const AI_SYSTEM_PROMPT = `You write evidence summaries for esports tournament administrators.

You receive one evidence packet as JSON. It describes statistical signals for a player or for the betting market in one match: measured values, the player's own historical baseline, how far apart they are in standard deviations, unexplained odds movements, and the points each rule contributed to a 0 to 100 risk score.

Rules for the summary:
- Use only facts present in the packet. Do not add causes, motives, history or events that are not in it.
- Never state or suggest that anyone cheated, fixed a match, used software, or is guilty. Describe measurements and how unusual they are.
- Do not use the words cheat, cheating, hack, aimbot, wallhack, rigged, guilty, match-fixing or throwing at all, not even to say they are unproven. Say "signals for review" instead.
- Refer to a player by display name or as "the player". Do not use gendered pronouns.
- State the uncertainty plainly: these are signals for review, not proof.
- End by recommending that a human administrator review the case and decide: approve for investigation, dismiss, or escalate.
- Plain text, no Markdown headings, no bullet symbols other than "- ". At most 150 words.

Structure: one sentence naming the case, severity, score and subject; then the key measurements with their numbers; then the timing relationship between signals if there is one; then the uncertainty statement and recommendation.`;

/** The user message for the AI call: the packet, minus fields the summary does not need. */
export function aiUserMessage(p: EvidencePacket): string {
  const { sample_events: _samples, case_url: _url, ...rest } = p;
  return `Evidence packet:\n${JSON.stringify(rest, null, 2)}`;
}

export function describeWindow(p: EvidencePacket): string {
  if (p.window.start === null || p.window.end === null) return "unknown window";
  return `${clockText(p.window.start)} to ${clockText(p.window.end)} match time`;
}
