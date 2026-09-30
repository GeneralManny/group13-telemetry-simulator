"use client";

import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import { ago, count } from "@/lib/format";
import type { DeadLetter, MonitorOverview, Session, SubjectRisk } from "@/lib/types";
import { SeverityChip } from "./Cases";
import { Icon, Loading, Skeleton, StatusChip, TableSkeleton, usePoll, type Notify } from "./ui";

const TEAM_COLOR = { team_blue: "var(--team-blue)", team_red: "var(--team-red)" } as const;

interface Props {
  session: Session | null;
  accessKey: string | null;
  notify: Notify;
}

export function Risk({ session, accessKey, notify }: Props) {
  const [overview, setOverview] = useState<MonitorOverview | null>(null);
  const [subjects, setSubjects] = useState<SubjectRisk[] | null>(null);
  const [letters, setLetters] = useState<DeadLetter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  usePoll(
    async () => {
      try {
        const [o, p, d] = await Promise.all([
          api<MonitorOverview>("/api/v1/monitor/overview"),
          api<{ subjects: SubjectRisk[] }>("/api/v1/monitor/players"),
          api<{ dead_letters: DeadLetter[] }>("/api/v1/monitor/dead-letters?limit=20"),
        ]);
        setOverview(o);
        setSubjects(p.subjects);
        setLetters(d.dead_letters);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    },
    2500,
    [],
  );

  const clearMonitor = async () => {
    if (
      !window.confirm(
        "Clear all monitor data (events, cases, reviews, dead letters)? Baselines and thresholds are kept.",
      )
    )
      return;
    setBusy(true);
    try {
      await api("/api/v1/monitor/reset", { method: "POST", key: accessKey });
      notify("Monitor data cleared. Baselines kept.", "good");
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "critical");
    } finally {
      setBusy(false);
    }
  };

  const p = overview?.pipeline;
  const pipelineTone =
    p?.status === "receiving" ? "good" : p?.status === "idle" ? "neutral" : "warning";

  return (
    <div className="stack-lg">
      <div className="section-intro">
        <h1>Players and risk</h1>
        <p>
          Every stored event is scored against the player&apos;s own history. 0 to 29 is normal, 30
          to 59 is worth monitoring, 60 and above opens a case for review.
        </p>
      </div>

      {error && !overview && (
        <p className="notice" data-tone="warning">
          <Icon name="warning" />
          {error.includes("not connected") ? "The monitor database is still connecting." : error}
        </p>
      )}

      <div className="stat-row" aria-label="Pipeline health">
        {!p ? (
          <Loading label="Loading pipeline health">
            <div className="stat-row">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div className="stat" key={i}>
                  <Skeleton width="60%" height={12} />
                  <Skeleton width="40%" height={26} />
                </div>
              ))}
            </div>
          </Loading>
        ) : (
          <>
            <div className="stat">
              <span className="stat-label">Pipeline</span>
              <StatusChip tone={pipelineTone}>
                {p.status === "receiving"
                  ? "Receiving"
                  : p.status === "idle"
                    ? "Idle"
                    : "Waiting for events"}
              </StatusChip>
              <span className="stat-note">Last event {ago(p.last_event_at)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Events stored</span>
              <span className="stat-value">{count(p.events_stored)}</span>
              <span className="stat-note">Each event_id once</span>
            </div>
            <div className="stat">
              <span className="stat-label">Last minute</span>
              <span className="stat-value">{count(p.events_last_minute)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Dead letters</span>
              <span className="stat-value">{count(p.dead_letters)}</span>
              <span className="stat-note">Rejected, logged, pipeline kept going</span>
            </div>
            <div className="stat">
              <span className="stat-label">Open cases</span>
              <span className="stat-value">
                {(overview?.cases.open ?? 0) +
                  (overview?.cases.pending_review ?? 0) +
                  (overview?.cases.escalated ?? 0)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">AI summaries</span>
              <StatusChip tone={p.ai_configured ? "good" : "warning"}>
                {p.ai_configured ? "AI connected" : "Template only"}
              </StatusChip>
            </div>
          </>
        )}
      </div>

      <section className="card" aria-labelledby="risk-title">
        <div className="card-head">
          <div>
            <h2 id="risk-title" className="card-title">
              Risk by player
            </h2>
            <p className="card-sub">
              Latest score and the highest score this match. Distance is measured against each
              player&apos;s own baseline.
            </p>
          </div>
        </div>
        {subjects === null ? (
          <TableSkeleton rows={11} columns={5} label="Loading risk" />
        ) : (
          <div className="table-wrap">
            <p className="swipe-hint">Swipe the table sideways to see every column.</p>
            <table className="data-table sticky-first">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  <th scope="col">Now</th>
                  <th scope="col" className="num">
                    Peak this match
                  </th>
                  <th scope="col">Rules triggered</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {subjects.map((s) => (
                  <tr key={s.subject}>
                    <th scope="row">
                      <span
                        className="team-dot"
                        style={{ background: s.team_id ? TEAM_COLOR[s.team_id] : "var(--muted)" }}
                        aria-hidden="true"
                      />
                      {s.display_name}{" "}
                      {s.subject !== "market" && <span className="muted mono">{s.subject}</span>}
                    </th>
                    <td>
                      {s.status === "insufficient_data" ? (
                        <StatusChip tone="neutral">No baseline</StatusChip>
                      ) : (
                        <SeverityChip severity={s.severity} score={s.score} />
                      )}
                    </td>
                    <td className="num">{s.peak_score}</td>
                    <td className="mono small">
                      {s.rules.length ? s.rules.join(", ") : <span className="muted">None</span>}
                    </td>
                    <td className="muted">{s.updated_at ? ago(s.updated_at) : "No data"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="dl-title">
        <div className="card-head">
          <div>
            <h2 id="dl-title" className="card-title">
              Dead letters
            </h2>
            <p className="card-sub">
              Events n8n rejected, with the reason. Later valid events are still processed.
            </p>
          </div>
          {session?.can_control_runs && (
            <button
              type="button"
              className="btn btn-danger btn-small"
              disabled={busy}
              onClick={clearMonitor}
            >
              Clear monitor data
            </button>
          )}
        </div>
        {letters === null ? (
          <TableSkeleton rows={3} columns={3} label="Loading dead letters" />
        ) : letters.length === 0 ? (
          <p className="empty">
            None. Run the Pipeline failure test preset to see invalid events land here.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Detail</th>
                  <th scope="col">Event</th>
                </tr>
              </thead>
              <tbody>
                {letters.map((l) => (
                  <tr key={l.id}>
                    <td className="muted">{ago(l.received_at)}</td>
                    <td>{l.reason}</td>
                    <td className="wrap">{l.error}</td>
                    <td className="mono">{l.event_id ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
