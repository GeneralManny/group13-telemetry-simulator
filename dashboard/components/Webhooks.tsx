"use client";

import { useState, type FormEvent } from "react";
import { ApiError, api } from "@/lib/api";
import { HEALTH_LABEL, ago, count, healthTone, randomToken, titleCase } from "@/lib/format";
import type { Destination, SendResult, Session } from "@/lib/types";
import { CopyButton, Icon, Loading, Skeleton, StatusChip, usePoll, type Notify } from "./ui";

interface Props {
  session: Session | null;
  accessKey: string | null;
  eventTypes: string[];
  notify: Notify;
  onUnlock: () => void;
}

interface WebhookList {
  destinations: Destination[];
  persistent: boolean;
  persist_error: string | null;
}

export function Webhooks({ session, accessKey, eventTypes, notify, onUnlock }: Props) {
  const allowed = Boolean(session?.can_manage_webhooks);
  const [data, setData] = useState<WebhookList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    if (!allowed) return;
    try {
      setData(await api<WebhookList>("/api/v1/webhooks", { key: accessKey }));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };
  usePoll(load, 4000, [accessKey, allowed], allowed);

  return (
    <div className="stack-lg">
      <div className="section-intro">
        <h1>Connect your n8n workflow</h1>
        <p>
          Add your n8n Webhook URL and the simulator sends every event to it as JSON, one event per
          request, starting with the next event. Use the team key your lead shared with you.
        </p>
      </div>

      {session === null ? (
        <WebhooksSkeleton />
      ) : !allowed ? (
        <section className="card locked-card">
          <Icon name="lock" size={20} />
          <h2 className="card-title">Unlock to manage webhooks</h2>
          <p className="card-sub">Enter the team key or the control key.</p>
          <button type="button" className="btn btn-primary" onClick={onUnlock}>
            Unlock
          </button>
        </section>
      ) : (
        <div className="webhooks-grid">
          <AddWebhook
            accessKey={accessKey}
            eventTypes={eventTypes}
            notify={notify}
            onAdded={load}
          />
          <section className="card" aria-labelledby="dest-title">
            <div className="card-head">
              <div>
                <h2 id="dest-title" className="card-title">
                  Destinations
                </h2>
                <p className="card-sub">Every enabled destination receives each event.</p>
              </div>
            </div>
            {data && !data.persistent && (
              <p className="notice" data-tone="warning">
                <Icon name="warning" />
                Webhooks added here are kept in memory and will be lost if the service restarts.
              </p>
            )}
            {loadError && (
              <p className="form-error" role="alert">
                {loadError}
              </p>
            )}
            {!data && !loadError && <DestinationSkeleton />}
            <ul className="destination-list">
              {(data?.destinations ?? []).map((d) => (
                <DestinationRow
                  key={d.id}
                  d={d}
                  accessKey={accessKey}
                  notify={notify}
                  onChange={load}
                />
              ))}
            </ul>
            {data && data.destinations.length === 0 && (
              <p className="empty">
                No destinations yet. Add your n8n Webhook URL to start receiving events.
              </p>
            )}
          </section>
          <SetupSteps />
        </div>
      )}
    </div>
  );
}

function DestinationSkeleton() {
  return (
    <Loading label="Loading destinations">
      <div className="destination-list" aria-hidden="true">
        {[0, 1].map((i) => (
          <div className="destination" key={i}>
            <div className="skeleton-stack">
              <Skeleton width="55%" height={16} />
              <Skeleton width="80%" height={11} />
              <Skeleton width="40%" height={11} />
            </div>
            <div className="skeleton-stack">
              <Skeleton width={90} height={22} radius={999} />
              <Skeleton width="70%" height={11} />
            </div>
            <div className="skeleton-row">
              <Skeleton width={54} height={30} radius={8} />
              <Skeleton width={60} height={30} radius={8} />
            </div>
          </div>
        ))}
      </div>
    </Loading>
  );
}

function WebhooksSkeleton() {
  return (
    <div className="webhooks-grid">
      <section className="card">
        <Loading label="Loading">
          <Skeleton width="45%" height={18} />
          {[0, 1, 2].map((i) => (
            <div className="skeleton-stack" key={i} style={{ gap: 6 }}>
              <Skeleton width={110} height={11} />
              <Skeleton height={38} radius={8} />
            </div>
          ))}
          <Skeleton height={64} radius={8} />
        </Loading>
      </section>
      <section className="card">
        <Skeleton width="35%" height={18} />
        <div style={{ height: 16 }} />
        <DestinationSkeleton />
      </section>
    </div>
  );
}

/**
 * Advice while typing, for the mistakes people make most often with n8n URLs. The server
 * makes the final decision; this only explains problems before the form is sent.
 */
function urlAdvice(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.endsWith(".local");
  const onDeployedSite = !["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (local && onDeployedSite) {
    return (
      "This address only exists on your own computer, so the simulator cannot reach it. " +
      "Give n8n a public address: use n8n Cloud, a hosted n8n, or run " +
      '"cloudflared tunnel --url http://localhost:5678" and paste the https address it prints, ' +
      "keeping the /webhook/... part."
    );
  }
  if (u.pathname.includes("/webhook-test/")) {
    return (
      "This is n8n's Test URL, which only works while the editor is listening. " +
      "Activate the workflow and use the Production URL (/webhook/...) instead."
    );
  }
  if (u.protocol === "http:" && onDeployedSite) {
    return "Use an https address. A tunnel such as Cloudflare Tunnel or ngrok provides one.";
  }
  return null;
}

function AddWebhook({
  accessKey,
  eventTypes,
  notify,
  onAdded,
}: {
  accessKey: string | null;
  eventTypes: string[];
  notify: Notify;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [all, setAll] = useState(true);
  const [types, setTypes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedToken, setSavedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!all && types.length === 0)
      return setError("Pick at least one event type, or choose All events.");
    setBusy(true);
    try {
      await api("/api/v1/webhooks", {
        method: "POST",
        key: accessKey,
        body: { name, url, token: token || null, event_types: all ? null : types },
      });
      notify(`${name} added. It receives events from now on.`, "good");
      setSavedToken(token || null);
      setName("");
      setUrl("");
      setToken("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="add-title">
      <h2 id="add-title" className="card-title">
        Add a webhook
      </h2>
      <form className="stack" onSubmit={submit} noValidate>
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="Team A ingestion"
            required
          />
        </label>
        <label className="field">
          <span>Webhook URL</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            placeholder="https://your-n8n.app/webhook/..."
            autoComplete="off"
            required
          />
          <span className="field-hint">
            In n8n, open the Webhook node and copy the Production URL.
          </span>
          {urlAdvice(url) && (
            <span className="notice field-notice" data-tone="warning" role="status">
              <Icon name="warning" />
              <span>{urlAdvice(url)}</span>
            </span>
          )}
        </label>
        <label className="field">
          <span>Shared token (optional)</span>
          <span className="input-with-btn">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              maxLength={200}
              autoComplete="off"
              placeholder="Sent as X-Simulator-Token"
            />
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setToken(randomToken())}
            >
              Generate
            </button>
          </span>
        </label>
        <fieldset className="event-types">
          <legend>Events to receive</legend>
          <label className="check">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            All events
          </label>
          {!all && (
            <div className="type-options">
              {eventTypes.map((t) => (
                <label key={t} className="check">
                  <input
                    type="checkbox"
                    checked={types.includes(t)}
                    onChange={(e) =>
                      setTypes((cur) =>
                        e.target.checked ? [...cur, t] : cur.filter((x) => x !== t),
                      )
                    }
                  />
                  {titleCase(t)}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !name || !url}>
            {busy ? "Adding" : "Add webhook"}
          </button>
        </div>
      </form>
      {savedToken && (
        <div className="token-reveal">
          <p>
            <strong>Save this token now.</strong> It is not shown again.
          </p>
          <div className="copy-row">
            <code>{savedToken}</code>
            <CopyButton text={savedToken} />
          </div>
          <p className="field-hint">
            In the n8n Webhook node set Authentication to Header Auth, name{" "}
            <code>X-Simulator-Token</code>, and this value.
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => setSavedToken(null)}
          >
            I have saved it
          </button>
        </div>
      )}
    </section>
  );
}

function DestinationRow({
  d,
  accessKey,
  notify,
  onChange,
}: {
  d: Destination;
  accessKey: string | null;
  notify: Notify;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : String(err), "critical");
    } finally {
      setBusy(false);
      onChange();
    }
  };
  const health = d.enabled ? d.delivery.health : "disabled";

  return (
    <li className="destination">
      <div className="destination-main">
        <div className="destination-title">
          <strong>{d.name}</strong>
          <span className="tag">
            {d.source === "environment" ? "Railway variable" : "Dashboard"}
          </span>
          {!d.enabled && <span className="tag">Paused</span>}
        </div>
        <span className="mono muted">{d.url_display}</span>
        <span className="muted">
          {d.event_types ? `${d.event_types.map(titleCase).join(", ")}` : "All events"}
          {d.token_set ? " · token set" : " · no token"}
        </span>
      </div>
      <div className="destination-stats">
        <StatusChip tone={d.enabled ? healthTone(health) : "neutral"}>
          {d.enabled ? HEALTH_LABEL[health] : "Paused"}
        </StatusChip>
        <span className="tabular">
          {count(d.delivery.delivered)} delivered · {count(d.delivery.failed)} failed
        </span>
        <span className="muted">
          {d.delivery.last_status_code
            ? `Last HTTP ${d.delivery.last_status_code}`
            : (d.delivery.last_error ?? "No attempts yet")}
          {d.delivery.last_attempt_at ? `, ${ago(d.delivery.last_attempt_at)}` : ""}
        </span>
      </div>
      <div className="destination-actions">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy || !d.enabled}
          onClick={() =>
            run(async () => {
              const r = await api<{ delivery: SendResult }>(`/api/v1/webhooks/${d.id}/test`, {
                method: "POST",
                key: accessKey,
                body: {},
              });
              if (r.delivery.ok)
                notify(`${d.name} answered HTTP ${r.delivery.status}. Connected.`, "good");
              else
                notify(
                  `${d.name} did not accept the event: ${r.delivery.error ?? `HTTP ${r.delivery.status}`}`,
                  "critical",
                );
            })
          }
        >
          Test
        </button>
        {d.source === "dashboard" && (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/api/v1/webhooks/${d.id}`, {
                    method: "PATCH",
                    key: accessKey,
                    body: { enabled: !d.enabled },
                  });
                  notify(`${d.name} ${d.enabled ? "paused" : "resumed"}`, "good");
                })
              }
            >
              {d.enabled ? "Pause" : "Resume"}
            </button>
            <button
              type="button"
              className="btn btn-danger btn-small"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Remove ${d.name}? It stops receiving events immediately.`))
                  return;
                void run(async () => {
                  await api(`/api/v1/webhooks/${d.id}`, { method: "DELETE", key: accessKey });
                  notify(`${d.name} removed`, "good");
                });
              }}
            >
              Remove
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function SetupSteps() {
  return (
    <section className="card setup-card" aria-labelledby="setup-title">
      <h2 id="setup-title" className="card-title">
        n8n setup in four steps
      </h2>
      <ol className="steps">
        <li>
          Add a <strong>Webhook</strong> node. HTTP Method <code>POST</code>, Respond{" "}
          <code>Immediately</code>.
        </li>
        <li>
          Optional: Authentication <code>Header Auth</code>, name <code>X-Simulator-Token</code>,
          value your token.
        </li>
        <li>
          Activate the workflow and copy the <strong>Production URL</strong>, not the Test URL.
        </li>
        <li>
          Add it here and press <strong>Test</strong>. HTTP 200 means you are connected.
        </li>
      </ol>
      <p className="field-hint">
        Deduplicate on <code>event_id</code>, because retries reuse it. Order by{" "}
        <code>sequence_number</code> within <code>simulator_run_id</code>. Failed deliveries are
        retried after 1, 3 and 10 seconds.
      </p>
    </section>
  );
}
