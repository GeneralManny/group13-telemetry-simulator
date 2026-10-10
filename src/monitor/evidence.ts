import type { RuleHit } from "./engine/risk.js";
import { RULE_IDS, clockText } from "./engine/risk.js";

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

const TEAM_NAMES: Record<string, string[]> = {
  team_blue: ["Team Blue", "team_blue", "Blue team"],
  team_red: ["Team Red", "team_red", "Red team"],
};

function teamName(teamId: string): string {
  return TEAM_NAMES[teamId]?.[0] ?? teamId;
}

function subjectLine(p: EvidencePacket): string {
  if (p.subject.type === "market") return "the match-winner betting market";
  return `${p.subject.display_name} (${p.subject.player_id}, ${teamName(p.subject.team_id)})`;
}

/** Event IDs of the odds moves the odds rule actually flagged for this case. */
function flaggedOddsIds(p: EvidencePacket): Set<string> {
  return new Set(
    p.rules.filter((r) => r.rule_id === RULE_IDS.odds).flatMap((r) => r.source_event_ids),
  );
}

/**
 * Plain-language direction of an odds move. Shortened odds mean the market now rates that team
 * more likely to win; models read "shortened" the wrong way round, so the summary is given this
 * sentence instead of having to interpret the field.
 */
function marketMovedToward(p: EvidencePacket, shortened: string | null): string | null {
  if (!shortened) return null;
  const name = teamName(shortened);
  if (p.subject.type !== "player") return name;
  return shortened === p.subject.team_id
    ? `${name}, the player's own team`
    : `${name}, the opposing team`;
}

const ESCAPE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A verb of favouring followed directly (or after "the") by the side it favours. */
const favouring = (targets: string[]) =>
  new RegExp(
    String.raw`\b(?:favou?r(?:s|ed|ing)?|in favou?r of|towards?|shift(?:s|ed|ing)? to)\s+(?:the\s+)?(?:${targets.join("|")})\b`,
    "i",
  );

/**
 * Checks that an AI summary does not reverse the direction of the flagged odds move, for
 * example "favoring the opposing team" when the odds shortened for the player's own team.
 * Skipped when the case has no flagged move or the flagged moves disagree on the team.
 */
export function directionViolations(text: string, p: EvidencePacket): string[] {
  const ids = flaggedOddsIds(p);
  const teams = new Set(
    p.odds_moves
      .filter((o) => ids.has(o.event_id) && o.shortened_team)
      .map((o) => o.shortened_team!),
  );
  if (teams.size !== 1) return [];
  const toward = [...teams][0]!;
  const other = toward === "team_blue" ? "team_red" : "team_blue";
  const wrong = (TEAM_NAMES[other] ?? [other]).map(ESCAPE);
  if (p.subject.type === "player") {
    if (toward === p.subject.team_id) {
      wrong.push(String.raw`(?:opposing|other|rival)\s+(?:team|side)`, String.raw`opponents?`);
    } else {
      wrong.push(
        String.raw`(?:player's|this player's|their)\s+(?:own\s+)?team`,
        String.raw`(?:its|their)\s+own\s+team`,
      );
    }
  }
  const re = favouring(wrong);
  const hit = re.exec(text);
  return hit ? [hit[0]] : [];
}

/**
 * Deterministic summary used when the AI service is unavailable, too slow, refuses, or produces
 * wording that fails the language check. Built only from packet fields, so it is always grounded.
 */
/**
 * Phrases that steer the reviewer toward one decision ("I recommend approving", "should be
 * escalated"). The summary may name the three choices but never favour one.
 */
const STEERING = [
  /\b(?:recommend|suggest|advise|propose|urge)(?:s|ed|ing)?\s+(?:that\s+)?(?:the\s+case\s+)?(?:be\s+)?(?:approv|escalat|dismiss|investigat|referr)\w*/i,
  /\b(?:should|must|ought to)\s+(?:be\s+)?(?:approved|escalated|dismissed|investigated|referred)\b/i,
  /\b(?:warrants?|merits?|justif(?:y|ies))\s+(?:an?\s+)?(?:investigation|escalation|dismissal|approval)\b/i,
];

/** Vague timing the packet never states; the summary must use the match times given. */
const VAGUE_TIMING = [
  /\b(?:final|closing|opening|dying)\s+(?:minutes?|moments?|stages?|seconds?|part)\b/i,
  /\blast\s+(?:few\s+)?(?:minutes|moments|stages)\b/i,
  /\b(?:late|early)\s+(?:in|on)\s+the\s+(?:match|game)\b/i,
  /\b(?:end|start)\s+of\s+the\s+(?:match|game)\b/i,
];

/**
 * Checks the AI summary leaves the decision to the reviewer and describes timing only with the
 * match times in the packet. Returns the offending phrases.
 */
export function neutralityViolations(text: string): string[] {
  return [...STEERING, ...VAGUE_TIMING].flatMap((re) => {
    const hit = re.exec(text);
    return hit ? [hit[0]] : [];
  });
}

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
- Odds direction: shortened odds mean the market now rates that team more likely to win. Each odds move has a market_moved_toward field; state that direction exactly as given and never reverse it. Mention only moves marked flagged: true.
- State the uncertainty plainly: these are signals for review, not proof.
- Timing: describe when something happened only with the match times given (window_match_time, and match_time on each odds move), for example "at 1:30". Do not describe a moment in other words such as early, late, or the final minutes.
- Do not recommend, suggest or favour any decision. End by stating that a human administrator reviews the case and chooses one of: approve for investigation, dismiss, or escalate.
- Plain text, no Markdown headings, no bullet symbols other than "- ". At most 150 words.

Structure: one sentence naming the case, severity, score and subject; then the key measurements with their numbers; then the timing relationship between signals if there is one; then the uncertainty statement and the closing line about human review.`;

/**
 * The user message for the AI call: the packet, minus fields the summary does not need, with
 * each odds move's direction spelled out next to its numbers.
 */
export function aiUserMessage(p: EvidencePacket): string {
  const { sample_events: _samples, case_url: _url, ...rest } = p;
  const flagged = flaggedOddsIds(p);
  const odds_moves = p.odds_moves.map(({ from: _from, to: _to, ...o }) => ({
    ...o,
    match_time: clockText(o.match_clock),
    market_moved_toward: marketMovedToward(p, o.shortened_team),
    flagged: flagged.has(o.event_id),
  }));
  const window_match_time = describeWindow(p);
  return `Evidence packet:\n${JSON.stringify({ ...rest, window_match_time, odds_moves }, null, 2)}`;
}

export function describeWindow(p: EvidencePacket): string {
  if (p.window.start === null || p.window.end === null) return "unknown window";
  return `${clockText(p.window.start)} to ${clockText(p.window.end)} match time`;
}
