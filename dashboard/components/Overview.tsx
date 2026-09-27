"use client";

import { useMemo, useState, type FormEvent } from "react";
import { ApiError, api } from "@/lib/api";
import { HEALTH_LABEL, STATE_LABEL, ago, clock, count, healthTone, titleCase } from "@/lib/format";
import type { Player, ScenarioCatalog, Session, Status, Timeline } from "@/lib/types";
import { LineChart, type Series } from "./LineChart";
import {
  ChartSkeleton,
  Icon,
  Loading,
  Skeleton,
  StatusChip,
  TableSkeleton,
  usePoll,
  type Notify,
  type Tone,
} from "./ui";

type Act = (
  label: string,
  path: string,
  body?: unknown,
  success?: string | ((res: Record<string, unknown>) => [string, Tone]),
) => Promise<Record<string, unknown> | undefined>;

const TEAM_COLOR = { team_blue: "var(--team-blue)", team_red: "var(--team-red)" } as const;
const TEAM_NAME = { team_blue: "Team Blue", team_red: "Team Red" } as const;

const PRESET_COPY: Record<string, { title: string; detail: string }> = {
  final_demo: {
    title: "Final demo",
    detail: "Combined case. player_07 changes at 1:00, odds shock at 1:30. 4 minutes.",
  },
  demo_normal: { title: "Normal match", detail: "Clean play for a no-alert baseline. 2 minutes." },
  performance_demo: {
    title: "Performance anomaly",
    detail: "player_07 reaction time and accuracy jump at 1:30. 5 minutes.",
  },
  odds_demo: {
    title: "Odds integrity",
    detail: "Sharp, unexplained odds move at 1:30. 4 minutes.",
  },
  pipeline_test: {
    title: "Pipeline failure test",
    detail: "Duplicates, bad fields, delays and a burst for Team A. 2 minutes.",
  },
};

interface Props {
  status: Status | null;
  session: Session | null;
  accessKey: string | null;
  catalog: ScenarioCatalog | null;
  players: Player[];
  notify: Notify;
  refresh: () => void;
  onUnlock: () => void;
}

export function Overview({
  status,
  session,
  accessKey,
  catalog,
  players,
  notify,
  refresh,
  onUnlock,
}: Props) {
  const [playerId, setPlayerId] = useState("player_07");
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const runId = status?.run_id ?? null;
  const live = status?.status === "running" || status?.status === "paused";

  usePoll(
    async () => {
      try {
        setTimeline(await api<Timeline>(`/api/v1/timeline?player=${playerId}`));
      } catch {
        // Status polling already reports connectivity problems.
      }
    },
    live ? 2000 : 15000,
    [playerId, runId, status?.status],
  );

  const act: Act = async (label, path, body, success) => {
    setBusy(label);
    try {
      const res = await api<Record<string, unknown>>(path, {
        method: "POST",
        body: body ?? {},
        key: accessKey,
      });
      const [text, tone] =
        typeof success === "function"
          ? success(res)
          : [success ?? `${label}: done`, "good" as Tone];
      notify(text, tone);
      refresh();
      return res;
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "critical");
    } finally {
      setBusy(null);
    }
  };

  const canControl = Boolean(session?.can_control_runs);
  const state = status?.status ?? "idle";
  const match = status?.match;

  return (
    <div className="stack-lg">
      <div className="overview-grid">
        <MatchCard status={status} />
        <section className="card control-card" aria-labelledby="control-title">
          <div className="card-head">
            <div>
              <h2 id="control-title" className="card-title">
                Controls
              </h2>
              <p className="card-sub">Saved presets replay the same match every time.</p>
            </div>
          </div>
          {session === null ? (
            <ControlsSkeleton />
          ) : !canControl ? (
            <div className="locked-note">
              <Icon name="lock" />
              <p>Unlock with the control key to start, pause and reset matches.</p>
              <button type="button" className="btn btn-secondary" onClick={onUnlock}>
                Unlock
              </button>
            </div>
          ) : (
            <Controls
              state={state}
              status={status}
              catalog={catalog}
              players={players}
              busy={busy}
              act={act}
            />
          )}
        </section>
      </div>

      <StatRow status={status} />

      <div className="chart-grid">
        <OddsCard
          timeline={timeline}
          xMax={match?.duration_seconds ?? timeline?.match?.duration_seconds ?? 240}
        />
        <PlayerCard
          timeline={timeline}
          players={players}
          playerId={playerId}
          setPlayerId={setPlayerId}
          xMax={match?.duration_seconds ?? timeline?.match?.duration_seconds ?? 240}
        />
      </div>

      <PlayersTable timeline={timeline} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function MatchCard({ status }: { status: Status | null }) {
  if (!status) return <MatchCardSkeleton />;
  const m = status?.match;
  const state = status?.status ?? "idle";
  const pct = m ? Math.min(100, (m.match_clock_seconds / m.duration_seconds) * 100) : 0;
  const scenario = status?.preset
    ? (PRESET_COPY[status.preset]?.title ?? titleCase(status.preset))
    : titleCase(status?.scenario);
  return (
    <section className="card match-card" aria-labelledby="match-title">
      <div className="card-head">
        <div>
          <h2 id="match-title" className="card-title">
            Current match
          </h2>
          <p className="card-sub">
            {status?.run_id
              ? `${scenario}${status.failure_modes_enabled ? ", with failure tests" : ""}`
              : "No match running"}
          </p>
        </div>
        <span className="state-badge" data-state={state}>
          <span className="state-dot" aria-hidden="true" />
          {STATE_LABEL[state]}
        </span>
      </div>

      <div
        className="scoreboard"
        aria-label={`Score: Team Blue ${m?.score.team_blue ?? 0}, Team Red ${m?.score.team_red ?? 0}`}
      >
        <div className="team">
          <span
            className="team-dot"
            style={{ background: TEAM_COLOR.team_blue }}
            aria-hidden="true"
          />
          <span>Team Blue</span>
        </div>
        <div className="score">
          <span>{m?.score.team_blue ?? 0}</span>
          <span className="score-sep" aria-hidden="true">
            :
          </span>
          <span>{m?.score.team_red ?? 0}</span>
        </div>
        <div className="team team-right">
          <span>Team Red</span>
          <span
            className="team-dot"
            style={{ background: TEAM_COLOR.team_red }}
            aria-hidden="true"
          />
        </div>
      </div>

      <div className="clock">
        <div className="clock-row">
          <span className="tabular">
            {clock(m?.match_clock_seconds)} / {clock(m?.duration_seconds)}
          </span>
          <span>{m ? `Round ${m.round_number} of ${m.total_rounds}` : "No rounds yet"}</span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-label="Match progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Seed</dt>
          <dd className="tabular">{status?.seed ?? "None"}</dd>
        </div>
        <div>
          <dt>Last event</dt>
          <dd>{ago(status?.last_event_at)}</dd>
        </div>
        <div className="meta-wide">
          <dt>Run ID</dt>
          <dd className="mono">{status?.run_id ?? status?.last_run_id ?? "None"}</dd>
        </div>
      </dl>
      {status?.error && (
        <p className="form-error" role="alert">
          Run failed: {status.error}
        </p>
      )}
    </section>
  );
}

function MatchCardSkeleton() {
  return (
    <section className="card match-card" aria-labelledby="match-title">
      <div className="card-head">
        <div>
          <h2 id="match-title" className="card-title">
            Current match
          </h2>
          <Skeleton width={140} height={12} />
        </div>
        <Skeleton width={96} height={30} radius={999} />
      </div>
      <Loading label="Loading match">
        <div className="scoreboard" aria-hidden="true">
          <Skeleton width={110} height={18} />
          <Skeleton width={120} height={52} radius={10} />
          <span className="team team-right">
            <Skeleton width={110} height={18} />
          </span>
        </div>
        <div className="skeleton-row" aria-hidden="true">
          <Skeleton width={90} height={12} />
          <Skeleton width={90} height={12} />
        </div>
        <Skeleton height={8} radius={999} />
        <div className="meta-grid" aria-hidden="true">
          <Skeleton width="50%" height={30} />
          <Skeleton width="50%" height={30} />
          <span className="meta-wide">
            <Skeleton width="70%" height={30} />
          </span>
        </div>
      </Loading>
    </section>
  );
}

function ControlsSkeleton() {
  return (
    <Loading label="Loading controls">
      <div className="skeleton-row" aria-hidden="true" style={{ justifyContent: "flex-start" }}>
        {[64, 74, 56, 66, 60].map((w, i) => (
          <Skeleton key={i} width={w} height={38} radius={8} />
        ))}
      </div>
      <div className="skeleton-stack" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div className="skeleton-row" key={i}>
            <div className="skeleton-stack" style={{ flex: 1, gap: 6 }}>
              <Skeleton width="40%" height={14} />
              <Skeleton width="75%" height={11} />
            </div>
            <Skeleton width={62} height={34} radius={8} />
          </div>
        ))}
      </div>
    </Loading>
  );
}

// ---------------------------------------------------------------------------

function Controls({
  state,
  status,
  catalog,
  players,
  busy,
  act,
}: {
  state: string;
  status: Status | null;
  catalog: ScenarioCatalog | null;
  players: Player[];
  busy: string | null;
  act: Act;
}) {
  const active = state === "running" || state === "paused";
  const hasRun = Boolean(status?.run_id);
  const canReplay = Boolean(status?.last_run_id) && !active;
  const [scenario, setScenario] = useState("combined");
  const info = catalog?.scenarios.find((s) => s.name === scenario);

  const startCustom = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { scenario };
    for (const [k, v] of form.entries()) {
      if (k === "scenario" || v === "") continue;
      body[k] = ["target_player_id", "anomaly_direction"].includes(k) ? v : Number(v);
    }
    await act("Start", "/api/v1/runs", body, "Custom run started");
  };

  return (
    <div className="stack">
      <div className="lifecycle" role="group" aria-label="Run controls">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={state !== "running" || !!busy}
          onClick={() => act("Pause", "/api/v1/runs/current/pause", undefined, "Paused")}
        >
          Pause
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={state !== "paused" || !!busy}
          onClick={() => act("Resume", "/api/v1/runs/current/resume", undefined, "Resumed")}
        >
          Resume
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!active || !!busy}
          onClick={() => act("Stop", "/api/v1/runs/current/stop", undefined, "Stopped")}
        >
          Stop
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!canReplay || !!busy}
          onClick={() =>
            act(
              "Replay",
              `/api/v1/runs/${status?.last_run_id}/replay`,
              undefined,
              "Replay started with the same seed",
            )
          }
        >
          Replay
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!hasRun || !!busy}
          onClick={() => {
            if (
              window.confirm(
                "Reset the simulator? The current run and its queued deliveries are cleared.",
              )
            ) {
              void act("Reset", "/api/v1/runs/current/reset", undefined, "Reset to idle");
            }
          }}
        >
          Reset
        </button>
      </div>
      {active && <p className="hint">A match is in progress. Stop or reset it to start another.</p>}

      <ul className="preset-list" aria-label="Presets">
        {Object.keys(catalog?.presets ?? PRESET_COPY).map((name) => {
          const copy = PRESET_COPY[name] ?? { title: titleCase(name), detail: "" };
          return (
            <li key={name}>
              <div>
                <strong>{copy.title}</strong>
                <span>{copy.detail}</span>
              </div>
              <button
                type="button"
                className={name === "final_demo" ? "btn btn-primary" : "btn btn-secondary"}
                disabled={active || !!busy}
                onClick={() =>
                  act("Start", "/api/v1/runs", { preset: name }, `${copy.title} started`)
                }
              >
                Start
              </button>
            </li>
          );
        })}
      </ul>

      <details className="custom-run">
        <summary>Custom run</summary>
        <form className="form-grid" onSubmit={startCustom}>
          <label className="field">
            <span>Scenario</span>
            <select value={scenario} onChange={(e) => setScenario(e.target.value)} name="scenario">
              {(catalog?.scenarios ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Seed</span>
            <input name="seed" type="number" min={0} step={1} placeholder="Random" />
          </label>
          <label className="field">
            <span>Duration (s)</span>
            <input name="duration_seconds" type="number" min={10} max={7200} defaultValue={240} />
          </label>
          <label className="field">
            <span>Events per second</span>
            <input
              name="event_rate_per_second"
              type="number"
              min={0.1}
              max={50}
              step={0.1}
              defaultValue={2}
            />
          </label>
          {(info?.performance_anomaly || info?.odds_anomaly) && (
            <label className="field">
              <span>Target player</span>
              <select name="target_player_id" defaultValue="player_07">
                {players.map((p) => (
                  <option key={p.player_id} value={p.player_id}>
                    {p.display_name} ({p.player_id})
                  </option>
                ))}
              </select>
            </label>
          )}
          {info?.performance_anomaly && (
            <>
              <label className="field">
                <span>Anomaly starts at (s)</span>
                <input name="anomaly_start_second" type="number" min={0} defaultValue={60} />
              </label>
              <label className="field">
                <span>Direction</span>
                <select name="anomaly_direction" defaultValue="over">
                  <option value="over">Overperformance</option>
                  <option value="under">Underperformance</option>
                </select>
              </label>
            </>
          )}
          {info?.odds_anomaly && (
            <label className="field">
              <span>Odds shock at (s)</span>
              <input name="odds_anomaly_start_second" type="number" min={0} defaultValue={90} />
            </label>
          )}
          {info && <p className="hint form-wide">{info.purpose}</p>}
          <div className="form-actions form-wide">
            <button type="submit" className="btn btn-primary" disabled={active || !!busy}>
              Start custom run
            </button>
          </div>
        </form>
      </details>

      <button
        type="button"
        className="btn btn-ghost"
        disabled={!!busy}
        onClick={() =>
          act("Test event", "/api/v1/test-event", {}, (res) => {
            const list = (res.deliveries ?? []) as {
              name: string | null;
              result: { ok: boolean; status: number | null };
            }[];
            if (list.length === 0)
              return ["No webhook is connected yet. Add one on the Webhooks tab.", "warning"];
            const ok = list.filter((d) => d.result.ok).length;
            return [
              `Test event: ${ok} of ${list.length} webhooks answered 2xx`,
              ok === list.length ? "good" : "warning",
            ];
          })
        }
      >
        Send one test event to every webhook
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatRow({ status }: { status: Status | null }) {
  if (!status) {
    const labels = ["Events generated", "Deliveries", "Failed", "Pending", "Retries", "Webhooks"];
    return (
      <Loading label="Loading delivery counters">
        <div className="stat-row" aria-hidden="true">
          {labels.map((label) => (
            <div className="stat" key={label}>
              <span className="stat-label">{label}</span>
              <Skeleton width="45%" height={28} />
              <Skeleton width="65%" height={10} />
            </div>
          ))}
        </div>
      </Loading>
    );
  }
  const s = status;
  const health = s?.webhook_status ?? "unknown";
  const dests = s?.webhook_target.destinations ?? 0;
  // Delivery counters count each event once per webhook, so they can exceed events generated.
  const per = dests > 1 ? `across ${dests} webhooks` : undefined;
  const tiles: [string, number, string | undefined][] = [
    ["Events generated", s?.events_generated ?? 0, "Match events so far"],
    ["Deliveries", s?.events_delivered ?? 0, per],
    ["Failed", s?.events_failed ?? 0, "After all retries"],
    ["Pending", s?.events_pending ?? 0, "Queued or in flight"],
    ["Retries", s?.delivery_retries ?? 0, undefined],
  ];
  return (
    <div className="stat-row" aria-label="Delivery counters">
      {tiles.map(([label, value, note]) => (
        <div className="stat" key={label}>
          <span className="stat-label">{label}</span>
          <span className="stat-value">{count(value)}</span>
          {note && <span className="stat-note">{note}</span>}
        </div>
      ))}
      <div className="stat">
        <span className="stat-label">Webhooks</span>
        <span className="stat-value">{s?.webhook_target.destinations ?? 0}</span>
        <StatusChip tone={healthTone(health)}>{HEALTH_LABEL[health]}</StatusChip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OddsCard({ timeline, xMax }: { timeline: Timeline | null; xMax: number }) {
  const [asTable, setAsTable] = useState(false);
  const odds = timeline?.odds ?? [];
  const series: Series[] = [
    {
      key: "blue",
      label: "Team Blue",
      color: TEAM_COLOR.team_blue,
      points: odds.map((o) => [o.t, o.team_blue]),
    },
    {
      key: "red",
      label: "Team Red",
      color: TEAM_COLOR.team_red,
      points: odds.map((o) => [o.t, o.team_red]),
    },
  ];
  // Mark the largest unexplained moves so they can be found on the chart.
  const annotations = odds
    .filter((o) => o.reason === "market_update" && o.movement_pct >= 15)
    .map((o) => ({
      x: o.t,
      y: Math.max(o.team_blue, o.team_red),
      label: `${o.movement_pct}% move`,
    }));

  return (
    <section className="card chart-card" aria-labelledby="odds-title">
      <div className="card-head">
        <div>
          <h2 id="odds-title" className="card-title">
            Match-winner odds
          </h2>
          <p className="card-sub">
            Decimal odds over the match clock. Lower means more likely to win.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
        >
          {asTable ? "View as chart" : "View as table"}
        </button>
      </div>
      {asTable ? (
        <div className="table-wrap table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Clock</th>
                <th scope="col" className="num">
                  Team Blue
                </th>
                <th scope="col" className="num">
                  Team Red
                </th>
                <th scope="col" className="num">
                  Move %
                </th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {odds.map((o) => (
                <tr key={o.seq}>
                  <td className="tabular">{clock(o.t)}</td>
                  <td className="num">{o.team_blue.toFixed(2)}</td>
                  <td className="num">{o.team_red.toFixed(2)}</td>
                  <td className="num">{o.movement_pct.toFixed(1)}</td>
                  <td>{titleCase(o.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {odds.length === 0 && <p className="empty">No odds yet.</p>}
        </div>
      ) : timeline === null ? (
        <ChartSkeleton height={400} label="Loading odds" />
      ) : (
        <LineChart
          series={series}
          xMax={xMax}
          height={400}
          ariaLabel="Match-winner odds for Team Blue and Team Red"
          yFormat={(v) => v.toFixed(2)}
          annotations={annotations}
          emptyText="Odds appear when a match starts"
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function PlayerCard({
  timeline,
  players,
  playerId,
  setPlayerId,
  xMax,
}: {
  timeline: Timeline | null;
  players: Player[];
  playerId: string;
  setPlayerId: (id: string) => void;
  xMax: number;
}) {
  const p = timeline?.player;
  // Also true right after switching player, until that player's data arrives.
  const loading = !p || p.player_id !== playerId;
  const samples = p && !loading ? p.samples : [];
  const baseline = p?.baseline ?? players.find((x) => x.player_id === playerId)?.baseline;
  const color = TEAM_COLOR[p?.team_id ?? "team_blue"];
  const band = (key: keyof NonNullable<typeof baseline>) =>
    baseline
      ? {
          lo: baseline[key].mean - 2.5 * baseline[key].stddev,
          hi: baseline[key].mean + 2.5 * baseline[key].stddev,
        }
      : undefined;
  const metric = (
    key: "reaction_time_ms" | "accuracy_pct" | "headshot_pct",
    label: string,
  ): Series[] => [{ key, label, color, points: samples.map((s) => [s.t, s[key]]) }];

  return (
    <section className="card chart-card" aria-labelledby="player-title">
      <div className="card-head">
        <div>
          <h2 id="player-title" className="card-title">
            Player metrics
          </h2>
          <p className="card-sub">Every action, against the player&apos;s baseline range</p>
        </div>
        {players.length === 0 ? (
          <Skeleton width={190} height={38} radius={8} />
        ) : (
          <label className="inline-select">
            <span className="visually-hidden">Player</span>
            <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
              {players.map((pl) => (
                <option key={pl.player_id} value={pl.player_id}>
                  {pl.display_name} ({pl.player_id})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ul className="legend" aria-label="Legend">
        <li>
          <span className="legend-line" style={{ background: color }} aria-hidden="true" />
          {p?.display_name ?? "Player"}
        </li>
        <li>
          <span className="legend-band" aria-hidden="true" />
          Baseline range (mean ± 2.5 sd)
        </li>
      </ul>
      {loading ? (
        <div className="multiples">
          {["Reaction time (ms)", "Accuracy (%)", "Headshot rate (%)"].map((title) => (
            <div key={title}>
              <h3 className="mini-title">{title}</h3>
              <ChartSkeleton height={130} label={`Loading ${title.toLowerCase()}`} />
            </div>
          ))}
        </div>
      ) : (
        <div className="multiples">
          <div>
            <h3 className="mini-title">Reaction time (ms)</h3>
            <LineChart
              series={metric("reaction_time_ms", "Reaction time")}
              xMax={xMax}
              height={130}
              ariaLabel="Reaction time"
              yFormat={(v) => `${Math.round(v)}`}
              band={band("reaction_time_ms")}
              emptyText="No actions yet"
            />
          </div>
          <div>
            <h3 className="mini-title">Accuracy (%)</h3>
            <LineChart
              series={metric("accuracy_pct", "Accuracy")}
              xMax={xMax}
              height={130}
              ariaLabel="Accuracy"
              yFormat={(v) => `${Math.round(v)}`}
              band={band("accuracy_pct")}
              emptyText="No actions yet"
            />
          </div>
          <div>
            <h3 className="mini-title">Headshot rate (%)</h3>
            <LineChart
              series={metric("headshot_pct", "Headshot rate")}
              xMax={xMax}
              height={130}
              ariaLabel="Headshot rate"
              yFormat={(v) => `${Math.round(v)}`}
              band={band("headshot_pct")}
              emptyText="No actions yet"
            />
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function PlayersTable({ timeline }: { timeline: Timeline | null }) {
  const rows = useMemo(
    () =>
      (timeline?.snapshots ?? []).map((s) => {
        const m = s.latest?.metrics;
        let worst: { label: string; z: number } | null = null;
        if (m) {
          for (const [key, label] of [
            ["reaction_time_ms", "reaction time"],
            ["accuracy_pct", "accuracy"],
            ["headshot_pct", "headshot rate"],
          ] as const) {
            const b = s.baseline[key];
            const z = (m[key]! - b.mean) / b.stddev;
            if (!worst || Math.abs(z) > Math.abs(worst.z)) worst = { label, z };
          }
        }
        return { s, m, worst };
      }),
    [timeline],
  );

  return (
    <section className="card" aria-labelledby="players-title">
      <div className="card-head">
        <div>
          <h2 id="players-title" className="card-title">
            Players
          </h2>
          <p className="card-sub">
            Latest 30-second snapshot. Distance from baseline is in standard deviations.
          </p>
        </div>
      </div>
      {!timeline ? (
        <TableSkeleton rows={10} columns={7} label="Loading players" />
      ) : (
        <>
          <p className="swipe-hint">Swipe the table sideways to see every column.</p>
          <div className="table-wrap">
            <table className="data-table sticky-first">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col" className="num">
                    Reaction ms
                  </th>
                  <th scope="col" className="num">
                    Accuracy %
                  </th>
                  <th scope="col" className="num">
                    Headshot %
                  </th>
                  <th scope="col" className="num">
                    APM
                  </th>
                  <th scope="col" className="num">
                    K / D / A
                  </th>
                  <th scope="col">Against baseline</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ s, m, worst }) => (
                  <tr key={s.player_id}>
                    <th scope="row">
                      <span
                        className="team-dot"
                        style={{ background: TEAM_COLOR[s.team_id] }}
                        aria-hidden="true"
                      />
                      {s.display_name} <span className="muted mono">{s.player_id}</span>
                      <span className="visually-hidden">, {TEAM_NAME[s.team_id]}</span>
                    </th>
                    <td className="num">{m ? m.reaction_time_ms : "-"}</td>
                    <td className="num">{m ? m.accuracy_pct : "-"}</td>
                    <td className="num">{m ? m.headshot_pct : "-"}</td>
                    <td className="num">{m ? m.actions_per_minute : "-"}</td>
                    <td className="num">{m ? `${m.kills} / ${m.deaths} / ${m.assists}` : "-"}</td>
                    <td>
                      {!worst ? (
                        <span className="muted">No snapshot yet</span>
                      ) : Math.abs(worst.z) <= 2.5 ? (
                        <StatusChip tone="good">Within range</StatusChip>
                      ) : (
                        <StatusChip tone="warning">
                          {Math.abs(worst.z).toFixed(1)} sd {worst.z > 0 ? "above" : "below"} on{" "}
                          {worst.label}
                        </StatusChip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="empty">Player snapshots appear when a match starts.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
