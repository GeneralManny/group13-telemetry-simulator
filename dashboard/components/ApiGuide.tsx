"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { CopyButton, Skeleton, TableSkeleton } from "./ui";

interface ApiIndex {
  endpoints: Record<string, string[]>;
}

const ACCESS_LABEL: Record<string, string> = {
  public: "Public",
  protected: "Control key",
  team_or_control_key: "Team or control key",
};

function Snippet({ code }: { code: string }) {
  return (
    <div className="code-block">
      <pre>{code}</pre>
      <CopyButton text={code} />
    </div>
  );
}

export function ApiGuide() {
  const [base, setBase] = useState("");
  const [index, setIndex] = useState<ApiIndex | null>(null);

  useEffect(() => {
    setBase(window.location.origin);
    api<ApiIndex>("/api")
      .then(setIndex)
      .catch(() => undefined);
  }, []);

  const start = `curl -X POST ${base}/api/v1/runs \\\n  -H "X-API-Key: $CONTROL_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"preset":"final_demo"}'`;
  const status = `curl ${base}/api/v1/status`;
  const reset = `curl -X POST ${base}/api/v1/runs/current/reset \\\n  -H "X-API-Key: $CONTROL_KEY"`;
  const webhook = `curl -X POST ${base}/api/v1/webhooks \\\n  -H "X-API-Key: $TEAM_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"name":"Team A ingestion","url":"https://your-n8n.app/webhook/...","token":"your-shared-token"}'`;

  return (
    <div className="stack-lg">
      <div className="section-intro">
        <h1>API guide</h1>
        <p>
          Everything in this dashboard is also available over HTTP. Protected calls need the{" "}
          <code>X-API-Key</code> header.
        </p>
      </div>
      <div className="guide-grid">
        <section className="card">
          <h2 className="card-title">Base URL</h2>
          {base ? (
            <div className="copy-row">
              <code>{base}</code>
              <CopyButton text={base} />
            </div>
          ) : (
            <Skeleton width="80%" height={30} radius={8} />
          )}
          <h3 className="mini-title">Check status</h3>
          <Snippet code={status} />
        </section>
        <section className="card">
          <h2 className="card-title">Run the final demo</h2>
          <Snippet code={start} />
          <h3 className="mini-title">Reset afterwards</h3>
          <Snippet code={reset} />
        </section>
        <section className="card">
          <h2 className="card-title">Register a webhook from code</h2>
          <Snippet code={webhook} />
          <p className="field-hint">
            Schema version 1.0. One event per request. Useful references:{" "}
            <a href="/api/v1/scenarios">scenarios and options</a>,{" "}
            <a href="/api/v1/players">player baselines</a>, <a href="/api">API index</a>.
          </p>
        </section>
        <section className="card">
          <h2 className="card-title">Endpoints</h2>
          {!index ? (
            <TableSkeleton rows={8} columns={2} label="Loading endpoints" />
          ) : (
            <div className="table-wrap">
              <table className="data-table endpoint-table">
                <thead>
                  <tr>
                    <th scope="col">Endpoint</th>
                    <th scope="col">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(index?.endpoints ?? {}).flatMap(([access, list]) =>
                    list.map((e) => (
                      <tr key={e}>
                        <td className="mono endpoint-path">{e}</td>
                        <td className="endpoint-access">{ACCESS_LABEL[access] ?? access}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
