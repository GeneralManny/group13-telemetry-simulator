"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "@/lib/api";
import { ago, clock, titleCase } from "@/lib/format";
import type {
  CaseDetail,
  CaseStatus,
  CaseSummary,
  ReviewAction,
  Session,
  Severity,
} from "@/lib/types";
import { LineChart } from "./LineChart";
import {
  Loading,
  Skeleton,
  StatusChip,
  TableSkeleton,
  usePoll,
  type Notify,
  type Tone,
} from "./ui";

export const SEVERITY_TONE: Record<Severity, Tone> = {
  normal: "good",
  monitor: "neutral",
  high: "warning",
  critical: "critical",
};
export const STATUS_LABEL: Record<CaseStatus, string> = {
  open: "Open",
  pending_review: "Pending review",
  approved: "Approved for investigation",
  dismissed: "Dismissed",
  escalated: "Escalated",
};
const ACTION_LABEL: Record<ReviewAction, string> = {
  approve_for_investigation: "Approve for investigation",
  escalate: "Escalate",
  dismiss: "Dismiss",
};
const METRIC_LABEL: Record<string, string> = {
  reaction_time_ms: "Reaction time (ms)",
  accuracy_pct: "Accuracy (%)",
  headshot_pct: "Headshot rate (%)",
  actions_per_minute: "Actions per minute",
};

export function SeverityChip({ severity, score }: { severity: Severity; score?: number }) {
  return (
    <StatusChip tone={SEVERITY_TONE[severity]}>
      {titleCase(severity)}
      {score !== undefined ? ` ${score}` : ""}
    </StatusChip>
  );
}

function selectedFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("case");
  } catch {
    return null;
  }
}

interface Props {
  session: Session | null;
  accessKey: string | null;
  notify: Notify;
  onUnlock: () => void;
}

export function Cases({ session, accessKey, notify, onUnlock }: Props) {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => setSelected(selectedFromUrl()), []);

  usePoll(
    async () => {
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      if (severity) q.set("severity", severity);
      try {
        const r = await api<{ cases: CaseSummary[] }>(`/api/v1/monitor/cases?${q}`);
        setCases(r.cases);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    3000,
    [status, severity],
  );

  const open = (id: string | null) => {
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("case", id);
    else url.searchParams.delete("case");
    history.replaceState(null, "", url.toString());
    if (id && window.matchMedia("(max-width: 1100px)").matches) {
      requestAnimationFrame(() =>
        document.getElementById("case-detail")?.scrollIntoView({ behavior: "smooth" }),
      );
    }
  };

  return (
    <div className="stack-lg">
      <div className="section-intro">
        <h1>Integrity cases</h1>
        <p>
          A case opens when a player&apos;s risk score reaches High (60). An unexplained odds move
          on its own scores Monitor and shows on the Risk tab; it raises a player&apos;s case when
          it lands close to that player&apos;s performance change. Each case lists the measurements
          behind it. These are signals for review, not conclusions: an administrator decides every
          case.
        </p>
      </div>

      <div className="toolbar" role="group" aria-label="Case filters">
        <label className="inline-select">
          <span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-select">
          <span>Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>

      <div className="cases-grid">
        <section className="card" aria-label="Case list">
          {error && cases === null ? (
            <p className="notice" data-tone="warning">
              {error.includes("not connected")
                ? "The monitor database is still connecting."
                : error}
            </p>
          ) : cases === null ? (
            <TableSkeleton rows={5} columns={4} label="Loading cases" />
          ) : cases.length === 0 ? (
            <p className="empty">
              No cases yet. Normal play never opens one; run the Final demo preset to see a case
              appear.
            </p>
          ) : (
            <ul className="case-list">
              {cases.map((c) => (
                <li key={c.case_id}>
                  <button
                    type="button"
                    className="case-row"
                    aria-current={selected === c.case_id ? "true" : undefined}
                    onClick={() => open(c.case_id)}
                  >
                    <span className="case-row-top">
                      <strong className="mono">{c.case_id}</strong>
                      <SeverityChip severity={c.severity} score={c.peak_score} />
                    </span>
                    <span>
                      {c.subject_type === "market"
                        ? "Betting market"
                        : `${c.display_name} (${c.player_id})`}
                    </span>
                    <span className="muted">
                      {STATUS_LABEL[c.status]} · {(c.rule_ids ?? []).length} rules · updated{" "}
                      {ago(c.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card case-detail" id="case-detail" aria-label="Case detail">
          {selected ? (
            <CaseView
              key={selected}
              caseId={selected}
              session={session}
              accessKey={accessKey}
              notify={notify}
              onUnlock={onUnlock}
            />
          ) : (
            <p className="empty">Select a case to see its evidence and review it.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function CaseView({
  caseId,
  session,
  accessKey,
  notify,
  onUnlock,
}: {
  caseId: string;
  session: Session | null;
  accessKey: string | null;
  notify: Notify;
  onUnlock: () => void;
}) {
  const [d, setD] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setD(await api<CaseDetail>(`/api/v1/monitor/cases/${encodeURIComponent(caseId)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };
  usePoll(load, 3000, [caseId]);

  if (error && !d) return <p className="form-error">{error}</p>;
  if (!d) {
    return (
      <Loading label="Loading case">
        <Skeleton width="40%" height={22} />
        <Skeleton width="70%" height={14} />
        <Skeleton height={120} radius={8} />
        <Skeleton height={180} radius={8} />
      </Loading>
    );
  }

  const c = d.case;
  const ev = d.evidence;
  const subject =
    ev.subject.type === "player"
      ? `${ev.subject.display_name} (${ev.subject.player_id}, ${ev.subject.team_id === "team_blue" ? "Team Blue" : "Team Red"})`
      : "Match-winner betting market";
  const history = d.score_history.map((h) => [h.t, h.score] as [number, number]);

  return (
    <div className="stack">
      <div className="case-head">
        <div>
          <h2 className="card-title mono">{c.case_id}</h2>
          <p className="card-sub">{subject}</p>
        </div>
        <div className="case-badges">
          <SeverityChip severity={c.severity} score={c.peak_score} />
          <span className="tag">{STATUS_LABEL[c.status]}</span>
        </div>
      </div>
      <p className="notice">
        Signals for human review only. No conclusion has been made about anyone.
      </p>

      <dl className="meta-grid case-meta">
        <div>
          <dt>Match</dt>
          <dd className="mono">{ev.match.match_id}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd className="tabular">
            {clock(ev.window.start)} to {clock(ev.window.end)}
          </dd>
        </div>
        <div>
          <dt>Evidence events</dt>
          <dd>{ev.evidence_event_count}</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>{ago(c.created_at)}</dd>
        </div>
      </dl>

      <div className="score-parts" aria-label="Score breakdown">
        <div className="stat">
          <span className="stat-label">Performance</span>
          <span className="stat-value">{ev.components.performance}</span>
          <span className="stat-note">of 60</span>
        </div>
        <div className="stat">
          <span className="stat-label">Odds</span>
          <span className="stat-value">{ev.components.odds}</span>
          <span className="stat-note">of 30</span>
        </div>
        <div className="stat">
          <span className="stat-label">Repeated signals</span>
          <span className="stat-value">{ev.components.cluster}</span>
          <span className="stat-note">of 10</span>
        </div>
      </div>

      <div>
        <h3 className="mini-title">Why this was flagged</h3>
        <ul className="rule-list">
          {ev.rules
            .filter((r) => r.points > 0)
            .map((r) => (
              <li key={r.rule_id}>
                <span className="rule-head">
                  <span className="mono">{r.rule_id}</span>
                  <span className="tag">+{r.points}</span>
                </span>
                <span>{r.description}</span>
              </li>
            ))}
        </ul>
      </div>

      {ev.metrics_vs_baseline.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="mini-title table-caption">
              Measured against this player&apos;s baseline
            </caption>
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col" className="num">
                  Baseline
                </th>
                <th scope="col" className="num">
                  In window
                </th>
                <th scope="col" className="num">
                  Distance
                </th>
              </tr>
            </thead>
            <tbody>
              {ev.metrics_vs_baseline.map((m) => (
                <tr key={m.metric}>
                  <th scope="row">{METRIC_LABEL[m.metric] ?? m.metric}</th>
                  <td className="num">
                    {m.baseline_mean.toFixed(1)} ± {m.baseline_stddev.toFixed(1)}
                  </td>
                  <td className="num">{m.window_average ?? "-"}</td>
                  <td className="num">
                    {m.deviation_sd === null
                      ? "within range"
                      : `${m.deviation_sd > 0 ? "+" : ""}${m.deviation_sd} sd`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 1 && (
        <div>
          <h3 className="mini-title">Risk score over the match</h3>
          <LineChart
            series={[
              { key: "score", label: "Risk score", color: "var(--team-blue)", points: history },
            ]}
            xMax={Math.max(ev.match.match_clock_seconds, history.at(-1)![0])}
            height={160}
            ariaLabel="Risk score over the match"
            yFormat={(v) => `${Math.round(v)}`}
            band={{ lo: 60, hi: 100 }}
          />
          <p className="field-hint">Shaded area: High and Critical (score 60 and above).</p>
        </div>
      )}

      <div className="summary-card">
        <h3 className="mini-title">
          Evidence summary{" "}
          <span className="tag">
            {c.ai_status === "generated"
              ? "AI, grounded in stored evidence"
              : c.ai_status === "fallback"
                ? "Template"
                : "Pending"}
          </span>
        </h3>
        {c.ai_summary ? (
          <p className="summary-text">{c.ai_summary}</p>
        ) : (
          <Skeleton height={60} radius={8} />
        )}
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Slack alert</dt>
          <dd>
            <StatusChip
              tone={
                c.alert_status === "sent"
                  ? "good"
                  : c.alert_status === "failed"
                    ? "critical"
                    : "neutral"
              }
            >
              {c.alert_status === "sent"
                ? "Delivered"
                : c.alert_status === "failed"
                  ? "Not delivered"
                  : "Pending"}
            </StatusChip>
            {c.alert_error && <span className="muted"> {c.alert_error}</span>}
          </dd>
        </div>
        <div>
          <dt>Trace ID</dt>
          <dd className="mono">{c.trace_id ?? "-"}</dd>
        </div>
      </dl>

      <ReviewPanel
        detail={d}
        session={session}
        accessKey={accessKey}
        notify={notify}
        onUnlock={onUnlock}
        onDone={load}
      />

      <div>
        <h3 className="mini-title">Audit trail</h3>
        <ol className="audit">
          {d.audit.map((a, i) => (
            <li key={i}>
              <span className="tabular muted">{new Date(a.at).toLocaleTimeString()}</span>
              <span>
                {a.from_status ? `${titleCase(a.from_status)} to ` : ""}
                {titleCase(a.to_status)} by {a.actor}
                {a.note ? `: ${a.note}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function ReviewPanel({
  detail,
  session,
  accessKey,
  notify,
  onUnlock,
  onDone,
}: {
  detail: CaseDetail;
  session: Session | null;
  accessKey: string | null;
  notify: Notify;
  onUnlock: () => void;
  onDone: () => void;
}) {
  const [reviewer, setReviewer] = useState(() => {
    try {
      return localStorage.getItem("g13_reviewer") ?? "";
    } catch {
      return "";
    }
  });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<ReviewAction | null>(null);
  const c = detail.case;
  const final = c.status === "approved" || c.status === "dismissed";

  if (final) {
    return (
      <div className="review-done">
        <h3 className="mini-title">Decision</h3>
        <p>
          {STATUS_LABEL[c.status]} by {c.reviewer} {c.reviewed_at ? ago(c.reviewed_at) : ""}.
          {c.review_notes ? ` Notes: ${c.review_notes}` : ""}
        </p>
      </div>
    );
  }
  if (!session?.can_review_cases) {
    return (
      <div className="locked-note">
        <p>Unlock with the control key to approve, dismiss or escalate this case.</p>
        <button type="button" className="btn btn-secondary" onClick={onUnlock}>
          Unlock
        </button>
      </div>
    );
  }

  const submit = async (action: ReviewAction, e?: FormEvent) => {
    e?.preventDefault();
    if (reviewer.trim().length < 2)
      return notify("Enter your name as the reviewer first.", "warning");
    setBusy(action);
    try {
      localStorage.setItem("g13_reviewer", reviewer.trim());
    } catch {
      // Remembering the name is a convenience only.
    }
    try {
      const r = await api<{ status: string; duplicate: boolean }>(
        `/api/v1/monitor/cases/${c.case_id}/review`,
        {
          method: "POST",
          key: accessKey,
          body: {
            action,
            reviewer: reviewer.trim(),
            notes: notes.trim() || null,
            channel: "dashboard",
          },
        },
      );
      notify(
        r.duplicate
          ? `Already ${r.status}; nothing changed.`
          : `${c.case_id}: ${ACTION_LABEL[action].toLowerCase()} recorded.`,
        "good",
      );
      setNotes("");
      onDone();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "critical");
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="review-panel stack" onSubmit={(e) => e.preventDefault()}>
      <h3 className="mini-title">Human review</h3>
      <div className="form-grid">
        <label className="field">
          <span>Reviewer</span>
          <input
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            maxLength={80}
            placeholder="Your name"
            autoComplete="name"
          />
        </label>
        <label className="field form-wide">
          <span>Notes (recorded with the decision)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            rows={3}
          />
        </label>
      </div>
      <div className="lifecycle">
        {(Object.keys(ACTION_LABEL) as ReviewAction[]).map((a) => (
          <button
            key={a}
            type="button"
            className={
              a === "approve_for_investigation"
                ? "btn btn-primary"
                : a === "dismiss"
                  ? "btn btn-danger"
                  : "btn btn-secondary"
            }
            disabled={busy !== null || (a === "escalate" && c.status === "escalated")}
            onClick={() => void submit(a)}
          >
            {busy === a ? "Saving" : ACTION_LABEL[a]}
          </button>
        ))}
      </div>
    </form>
  );
}
