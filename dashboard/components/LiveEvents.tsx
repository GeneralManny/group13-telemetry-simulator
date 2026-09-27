"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { clock, titleCase } from "@/lib/format";
import type { EmittedEvent, Player } from "@/lib/types";
import { CopyButton, TableSkeleton } from "./ui";

const MAX_ROWS = 400;

// Payloads can be deliberately malformed (failure tests), so fields are read loosely.
type Payload = Record<string, any>;

function summary(p: Payload): string {
  const m = p.metrics ?? {};
  const d = p.data ?? {};
  const o = p.odds ?? {};
  switch (p.event_type) {
    case "player_action":
      return `${titleCase(d.action_type)}: ${m.reaction_time_ms} ms, ${m.accuracy_pct}% accuracy`;
    case "combat_event":
      return `${d.result === "kill" ? "Kill" : "Damage"} on ${d.target_player_id} with ${titleCase(d.weapon)}${d.headshot ? ", headshot" : ""}`;
    case "player_snapshot":
      return `30s avg ${m.reaction_time_ms} ms, ${m.accuracy_pct}% accuracy, ${m.kills} kills`;
    case "odds_update":
      return `Blue ${o.team_blue} / Red ${o.team_red}, ${o.movement_pct}% move (${titleCase(d.reason)})`;
    case "round_started":
      return `Round ${d.round_number} starts, score ${d.score?.team_blue}:${d.score?.team_red}`;
    case "round_ended":
      return `Round ${d.round_number} to ${titleCase(d.winner_team_id)}, score ${d.score?.team_blue}:${d.score?.team_red}`;
    case "match_started":
      return `${d.total_rounds} rounds on ${titleCase(d.map)}`;
    case "match_ended":
      return `${titleCase(d.winner_team_id)} wins ${d.final_score?.team_blue}:${d.final_score?.team_red}`;
    default:
      return "";
  }
}

export function LiveEvents({
  players,
  eventTypes,
  active,
}: {
  players: Player[];
  eventTypes: string[];
  active: boolean;
}) {
  const [events, setEvents] = useState<EmittedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [type, setType] = useState("");
  const [player, setPlayer] = useState("");
  const [selected, setSelected] = useState<EmittedEvent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const pausedRef = useRef(paused);
  const jsonRef = useRef<HTMLElement>(null);
  const feedRef = useRef<HTMLElement>(null);
  // On stacked (narrow) layouts the payload sits below the list, so bring it into view.
  const select = (e: EmittedEvent) => {
    setSelected(e);
    if (window.matchMedia("(max-width: 1100px)").matches) {
      requestAnimationFrame(() =>
        jsonRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  };
  pausedRef.current = paused;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api<{ events: EmittedEvent[] }>("/api/v1/events/recent?limit=150")
      .then((r) => !cancelled && setEvents(r.events))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoaded(true));

    const source = new EventSource("/api/v1/events/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("telemetry", (msg) => {
      if (pausedRef.current) return;
      try {
        const e = JSON.parse((msg as MessageEvent<string>).data) as EmittedEvent;
        setEvents((cur) => [e, ...cur].slice(0, MAX_ROWS));
      } catch {
        // Ignore a malformed preview frame.
      }
    });
    return () => {
      cancelled = true;
      source.close();
      setConnected(false);
    };
  }, [active]);

  const visible = useMemo(
    () =>
      events.filter(
        (e) =>
          (!type || e.payload.event_type === type) && (!player || e.payload.player_id === player),
      ),
    [events, type, player],
  );
  const json = selected ? JSON.stringify(selected.payload, null, 2) : "";

  return (
    <div className="stack-lg">
      <div className="toolbar" role="group" aria-label="Event filters">
        <label className="inline-select">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-select">
          <span>Player</span>
          <select value={player} onChange={(e) => setPlayer(e.target.value)}>
            <option value="">All players</option>
            {players.map((p) => (
              <option key={p.player_id} value={p.player_id}>
                {p.display_name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={paused}
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? "Resume feed" : "Pause feed"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setEvents([])}>
          Clear
        </button>
        <span className="pill" data-tone={connected ? "good" : "neutral"}>
          <span className="state-dot" aria-hidden="true" />
          {connected ? (paused ? "Connected, paused" : "Live") : "Connecting"}
        </span>
      </div>

      <div className="events-grid">
        <section className="card feed-card" aria-label="Event feed" ref={feedRef}>
          <div className="table-wrap table-scroll tall">
            <table className="data-table feed-table">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    Seq
                  </th>
                  <th scope="col">Clock</th>
                  <th scope="col">Type</th>
                  <th scope="col">Player</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e, i) => {
                  const p = e.payload as Payload;
                  const isSel = selected === e;
                  return (
                    <tr
                      key={`${String(p.event_id)}-${i}`}
                      className={isSel ? "selected" : undefined}
                      tabIndex={0}
                      onClick={() => select(e)}
                      onKeyDown={(k) =>
                        (k.key === "Enter" || k.key === " ") && (k.preventDefault(), select(e))
                      }
                      aria-selected={isSel}
                    >
                      <td className="num feed-seq">{String(p.sequence_number ?? "-")}</td>
                      <td className="tabular feed-clock">
                        {clock(p.metadata?.match_clock_seconds)}
                      </td>
                      <td className="feed-type">
                        <span className="type-tag" data-type={String(p.event_type)}>
                          {titleCase(String(p.event_type ?? "unknown"))}
                        </span>
                        {e.fault && (
                          <span className="tag tag-fault">Fault: {titleCase(e.fault)}</span>
                        )}
                      </td>
                      <td className="mono feed-player">{String(p.player_id ?? "")}</td>
                      <td className="feed-detail">{summary(p)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loaded ? (
              <TableSkeleton rows={10} columns={5} label="Loading events" />
            ) : (
              visible.length === 0 && (
                <p className="empty">Waiting for events. Start a match on the Overview tab.</p>
              )
            )}
          </div>
        </section>
        <aside className="card json-card" aria-labelledby="json-title" ref={jsonRef}>
          <div className="card-head">
            <h2 id="json-title" className="card-title">
              Event payload
            </h2>
            <div className="card-actions">
              {selected && (
                <button
                  type="button"
                  className="btn btn-ghost btn-small narrow-only"
                  onClick={() =>
                    feedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  Back to list
                </button>
              )}
              {selected && <CopyButton text={json} />}
            </div>
          </div>
          <pre className="json-view">
            {selected ? json : "Select an event to see the exact JSON your webhook receives."}
          </pre>
        </aside>
      </div>
    </div>
  );
}
