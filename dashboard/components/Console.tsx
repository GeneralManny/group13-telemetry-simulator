"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, loadKey, saveKey } from "@/lib/api";
import type { Player, ScenarioCatalog, Session, Status } from "@/lib/types";
import { ApiGuide } from "./ApiGuide";
import { Cases } from "./Cases";
import { Risk } from "./Risk";
import { KeyDialog } from "./KeyDialog";
import { LiveEvents } from "./LiveEvents";
import { Overview } from "./Overview";
import { Icon, Skeleton, ToastRegion, usePoll, useToasts } from "./ui";
import { Webhooks } from "./Webhooks";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "cases", label: "Cases" },
  { id: "risk", label: "Risk" },
  { id: "webhooks", label: "Webhooks" },
  { id: "events", label: "Live events" },
  { id: "guide", label: "API guide" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const THEME_KEY = "g13_theme";

export function Console() {
  const [tab, setTab] = useState<TabId>("overview");
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [ready, setReady] = useState<{ status: string; missing_variables: string[] } | null>(null);
  const [catalog, setCatalog] = useState<ScenarioCatalog | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [keyOpen, setKeyOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const { toasts, notify } = useToasts();

  // Tab from the URL hash, so links like /#webhooks open the right section.
  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1) as TabId;
      if (TABS.some((t) => t.id === id)) setTab(id);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    setDark(
      document.documentElement.dataset.theme === "dark" ||
        (!document.documentElement.dataset.theme &&
          matchMedia("(prefers-color-scheme: dark)").matches),
    );
    setAccessKey(loadKey());
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  useEffect(() => {
    api<Session>("/api/v1/session", { key: accessKey })
      .then(setSession)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          saveKey(null);
          setAccessKey(null);
          notify("The saved key is no longer valid. Unlock again.", "warning");
        }
      });
  }, [accessKey, notify]);

  useEffect(() => {
    api<ScenarioCatalog>("/api/v1/scenarios")
      .then(setCatalog)
      .catch(() => undefined);
    api<{ players: Player[] }>("/api/v1/players")
      .then((r) => setPlayers(r.players))
      .catch(() => undefined);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/v1/status"));
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);
  usePoll(refreshStatus, 1500, []);
  usePoll(
    async () => {
      try {
        setReady(await api("/ready"));
      } catch (err) {
        // /ready answers 503 with a body when configuration is incomplete.
        if (err instanceof ApiError && err.status === 503)
          setReady({ status: "not_ready", missing_variables: [] });
      }
    },
    15000,
    [],
  );

  const go = (id: TabId) => {
    setTab(id);
    history.replaceState(null, "", `#${id}`);
  };

  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setDark(!dark);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Theme choice then lasts until reload.
    }
  };

  const role = session?.role;
  const pill =
    reachable === false
      ? { tone: "critical", text: "Simulator offline" }
      : reachable === null
        ? { tone: "neutral", text: "Connecting" }
        : ready?.status === "not_ready"
          ? { tone: "warning", text: "Online, setup incomplete" }
          : { tone: "good", text: "Online" };

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <rect width="32" height="32" rx="8" />
              <path d="M7 20l5-6 4 4 7-9" />
            </svg>
          </span>
          <div className="brand-text">
            <strong>Group 13 Simulator</strong>
            <span>Live telemetry and odds</span>
          </div>
        </div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="tab"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => go(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          <span className="pill" data-tone={pill.tone}>
            <span className="state-dot" aria-hidden="true" />
            {pill.text}
          </span>
          <button
            type="button"
            className="icon-btn"
            onClick={toggleTheme}
            aria-label={dark ? "Use light theme" : "Use dark theme"}
          >
            <Icon name={dark ? "sun" : "moon"} />
          </button>
          {session === null && reachable !== false ? (
            <Skeleton width={96} height={38} radius={8} />
          ) : session?.open ? (
            <span
              className="pill"
              data-tone="warning"
              title="No CONTROL_API_KEY is set, so everything is open"
            >
              <span className="state-dot" aria-hidden="true" />
              Open (development)
            </span>
          ) : role ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                saveKey(null);
                setAccessKey(null);
                notify("Locked", "neutral");
              }}
              title="Forget the key in this tab"
            >
              <Icon name="unlock" />
              {role === "admin" ? "Control" : "Team"}
              <span className="visually-hidden">access. Select to lock.</span>
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setKeyOpen(true)}>
              <Icon name="lock" />
              Unlock
            </button>
          )}
        </div>
      </header>

      <main id="main" className="page">
        {reachable === false && (
          <div className="offline-banner" role="alert">
            <Icon name="critical" />
            <span>
              The simulator is not answering. Retrying every few seconds; the page updates as soon
              as it is back.
            </span>
          </div>
        )}
        {tab === "overview" && (
          <Overview
            status={status}
            session={session}
            accessKey={accessKey}
            catalog={catalog}
            players={players}
            notify={notify}
            refresh={refreshStatus}
            onUnlock={() => setKeyOpen(true)}
          />
        )}
        {tab === "cases" && (
          <Cases
            session={session}
            accessKey={accessKey}
            notify={notify}
            onUnlock={() => setKeyOpen(true)}
          />
        )}
        {tab === "risk" && <Risk session={session} accessKey={accessKey} notify={notify} />}
        {tab === "webhooks" && (
          <Webhooks
            session={session}
            accessKey={accessKey}
            eventTypes={catalog?.event_types ?? []}
            notify={notify}
            onUnlock={() => setKeyOpen(true)}
          />
        )}
        <div hidden={tab !== "events"}>
          <LiveEvents
            players={players}
            eventTypes={catalog?.event_types ?? []}
            active={tab === "events"}
          />
        </div>
        {tab === "guide" && <ApiGuide />}
      </main>

      <footer className="footer">
        <span>
          {status
            ? `${status.service} v${status.version}, schema ${status.schema_version}`
            : "Group 13 simulator"}
        </span>
        <span>Test evidence only. The simulator never labels a player or match.</span>
      </footer>

      <KeyDialog
        open={keyOpen}
        onClose={() => setKeyOpen(false)}
        onUnlocked={(key, s) => {
          saveKey(key);
          setAccessKey(key);
          setSession(s);
          setKeyOpen(false);
          notify(
            s.role === "admin" ? "Unlocked with the control key" : "Unlocked with the team key",
            "good",
          );
        }}
      />
      <ToastRegion toasts={toasts} />
    </>
  );
}
