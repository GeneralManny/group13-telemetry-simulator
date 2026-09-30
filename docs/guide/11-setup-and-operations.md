# 11. Setup and operations

## What this chapter covers

How the system is hosted on Railway, which settings each service needs (by name only), how to deploy, how the n8n workflows are rebuilt, how to fix common problems, and the known limitations. Deploying is Emmanuel's job; everyone else should understand it well enough to explain it.

## Railway services

Project: "group13-telemetry-simulator".

| Service             | What it runs                                             | Health check       | Public address                                             |
| ------------------- | -------------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| telemetry-simulator | Simulator, monitor API and dashboard (root `Dockerfile`) | `/health`          | https://telemetry-simulator-production-bf55.up.railway.app |
| n8n                 | n8n 2.41.4 with our workflows (`n8n/Dockerfile`)         | `/healthz`         | https://n8n-production-d5d3.up.railway.app                 |
| Postgres            | The database, schemas `monitor` and `n8n`                | Managed by Railway | None                                                       |

Each service runs as a single instance (one replica).

## Variables, by name

Values live only in each service's Variables tab on Railway. Never write them in the repository, a workflow, chat, a slide or a screenshot.

telemetry-simulator:

| Variable                  | Purpose                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| NODE_ENV                  | `production` on Railway                                                                |
| PORT                      | 3000                                                                                   |
| CONTROL_API_KEY           | Admin key: runs, test events, case reviews in the dashboard, monitor reset, thresholds |
| TEAM_ACCESS_KEY           | Webhook management only                                                                |
| N8N_WEBHOOK_URL           | Where events go: `http://n8n.railway.internal:5678/webhook/telemetry`                  |
| N8N_WEBHOOK_TOKEN         | Shared token sent as the `X-Simulator-Token` header                                    |
| DATABASE_URL              | Connection to the Postgres service                                                     |
| MONITOR_INGEST_KEY        | Key n8n uses to write events, dead letters, summaries, alert results and Slack reviews |
| OPENROUTER_API_KEY        | AI summaries through OpenRouter free models. Without it, the template is used          |
| OPENROUTER_MODELS         | Optional. Comma-separated free models, tried in order                                  |
| PUBLIC_BASE_URL           | The dashboard address, used for the "Open case" link                                   |
| DATA_DIR                  | `/data`, a Railway volume where dashboard webhooks are saved                           |
| RAILWAY_RUN_UID           | `0`, so the app can write to the volume                                                |
| ALLOWED_ORIGIN, LOG_LEVEL | Optional                                                                               |

n8n:

| Variable                                                                                                            | Purpose                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| MONITOR_API_URL                                                                                                     | `http://telemetry-simulator.railway.internal:3000`, the service's private address; the workflows add `/api/v1/monitor` |
| MONITOR_INGEST_KEY                                                                                                  | Same value as on telemetry-simulator                                                                                   |
| SIMULATOR_WEBHOOK_TOKEN                                                                                             | Same value as `N8N_WEBHOOK_TOKEN` on telemetry-simulator                                                               |
| SLACK_WEBHOOK_URL                                                                                                   | Slack incoming webhook for alerts                                                                                      |
| SLACK_SIGNING_SECRET                                                                                                | Verifies Slack button clicks                                                                                           |
| SLACK_INTERACTIVE                                                                                                   | `true` to add the review buttons to alerts                                                                             |
| DASHBOARD_URL                                                                                                       | The public dashboard address                                                                                           |
| DB_TYPE, DB_POSTGRESDB_HOST, DB_POSTGRESDB_PORT, DB_POSTGRESDB_DATABASE, DB_POSTGRESDB_USER, DB_POSTGRESDB_PASSWORD | n8n's own storage in the shared Postgres, filled by Railway references to the Postgres service                         |
| DB_POSTGRESDB_SCHEMA                                                                                                | `n8n`, keeps n8n's tables apart from the monitor's                                                                     |
| N8N_ENCRYPTION_KEY                                                                                                  | Encrypts n8n's stored credentials. Never change it once set                                                            |
| N8N_HOST, WEBHOOK_URL, N8N_PROTOCOL, N8N_PORT, N8N_LISTEN_ADDRESS, N8N_PROXY_HOPS                                   | The public address n8n shows and listens on (port 5678, both IPv4 and IPv6)                                            |
| N8N_BLOCK_ENV_ACCESS_IN_NODE                                                                                        | `false`, so workflows can read the variables above through `$env`                                                      |
| NODE_FUNCTION_ALLOW_BUILTIN                                                                                         | `crypto`, needed to verify Slack signatures                                                                            |
| EXECUTIONS_DATA_SAVE_ON_SUCCESS, EXECUTIONS_DATA_SAVE_ON_ERROR, EXECUTIONS_DATA_PRUNE, EXECUTIONS_DATA_MAX_AGE      | Keep failed runs (for retry), skip saving thousands of successful ingestion runs, prune after 7 days                   |

n8n also has its own settings on that tab: its database connection (to the same Postgres, schema `n8n`), its encryption key, its public address, and permission for Code nodes to read environment variables and use Node's `crypto` module (the Slack signature check needs it). Check the Variables tab for their exact names before changing anything there.

Pairs that must match: `N8N_WEBHOOK_TOKEN` and `SIMULATOR_WEBHOOK_TOKEN`; `MONITOR_INGEST_KEY` on both services.

## Deploying

Railway is not linked to GitHub, so a push does not deploy. Deploys are made from the repository folder with the Railway command-line tool.

1. Confirm you are logged into the right Railway account (the tool on the lead's machine is sometimes logged into another account):

```
railway whoami
```

2. Deploy the main service from the repository root:

```
railway up --service telemetry-simulator --detach
```

3. Deploy n8n from its own folder, treating that folder as the project root:

```
railway up n8n --path-as-root --service n8n --detach
```

4. Check: `/health` returns 200, `/ready` returns `"status": "ready"` with `"monitor": "ready"`, the dashboard pill says Online, and the n8n editor shows the three workflows published.

Notes:

- The repository's security hook refuses `railway up` unless a security review has been recorded for the exact commit being deployed.
- The Railway tool sometimes fails with a TLS error. Retry the same command.
- `railway up` skips anything matched by `.gitignore`, so a careless pattern there can silently drop source files.
- Do not deploy on demo day unless something is broken. Keep the known-good release running.

## How the n8n workflows are built and loaded

The three workflows are written as readable TypeScript in `scripts/build-n8n-workflows.ts`. The JavaScript inside each Code node is plain code there, so it can be reviewed.

1. Edit `scripts/build-n8n-workflows.ts`.
2. Generate the workflow files:

```
npm run n8n:build
```

This rewrites `n8n/workflows/1-ingest-telemetry.json`, `2-evidence-and-alert.json` and `3-slack-review.json`.

3. Search the generated files for anything secret-looking before committing. They should only contain `$env` references.
4. Redeploy the n8n service (step 3 above).

On every start, `n8n/start.sh` imports every file in `n8n/workflows/` (the same workflow ID updates in place), publishes each one, then starts n8n. The repository is the source of truth: a change made only in the n8n editor is overwritten on the next deploy or restart.

## Running it locally (optional)

```
npm install && npm run install:dashboard
npm run build:dashboard
docker run -d --name g13-local-pg -e POSTGRES_PASSWORD=localpass -p 55433:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres:localpass@localhost:55433/postgres NODE_ENV=development npm run dev
```

`localpass` is a throwaway password for a database on your own laptop, not a project secret. In development, with no `CONTROL_API_KEY`, the controls are open and the header shows "Open (development)". Without `N8N_WEBHOOK_URL`, runs are dry runs: events are generated but not sent. `npm run mock-webhook` starts a stand-in webhook on port 4000 if you want to see deliveries.

## Troubleshooting

| Symptom                                                                  | Where to look                                                     | Likely cause and fix                                                                                |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Dashboard pill "Simulator offline"                                       | Railway, telemetry-simulator logs                                 | Service restarting or crashed; wait, then check the log line "simulator starting"                   |
| `/ready` returns 503                                                     | `missing_variables` and `invalid_variables` in the response       | Add or fix the named variable; Railway redeploys                                                    |
| "The monitor database is still connecting"                               | `/ready` shows `"monitor": "connecting"`                          | Postgres restarting or `DATABASE_URL` wrong; the monitor retries every few seconds                  |
| Events generated but Deliveries flat                                     | Overview webhook health, `last_response_code` in `/api/v1/status` | 404: n8n workflow not published; restart n8n. 5xx or timeouts: n8n down                             |
| Deliveries rise but Events stored does not                               | Risk tab Dead letters                                             | Token mismatch or monitor rejecting events; read the dead letter reason                             |
| Every event is a dead letter "missing or wrong X-Simulator-Token header" | Variables on both services                                        | `N8N_WEBHOOK_TOKEN` and `SIMULATOR_WEBHOOK_TOKEN` differ                                            |
| n8n calls to the monitor fail with 401 or 403                            | n8n executions list                                               | `MONITOR_INGEST_KEY` differs between services                                                       |
| Case created but "Slack alert: Not delivered"                            | Case page error text                                              | `slack_not_configured`: set `SLACK_WEBHOOK_URL`. Other errors: Slack webhook revoked or Slack down  |
| Summary always "Template"                                                | Risk tab "AI summaries"                                           | `OPENROUTER_API_KEY` missing or invalid; the log names the reason, for example `ai_auth_failed`     |
| Slack buttons missing                                                    | n8n Variables                                                     | `SLACK_INTERACTIVE` is not `true`                                                                   |
| Slack click does nothing                                                 | "G13 3 - Slack review buttons" executions                         | Interactivity Request URL wrong, or `SLACK_SIGNING_SECRET` wrong ("Slack signature does not match") |
| Start refused with 409                                                   | Overview state badge                                              | A run is active; Reset first                                                                        |
| Scores differ from this guide                                            | Overview seed and preset                                          | A custom run was used; use the `final_demo` preset. Thresholds may have been changed in settings    |
| An n8n edit vanished                                                     | `n8n/start.sh`                                                    | Editor changes are overwritten on restart; change the build script instead                          |

## Known limitations

- Single instance. Each service runs one copy. The simulator keeps its run state in memory, so a restart returns it to idle and the last run cannot be resumed (it can be started again from the preset).
- Case pages are readable without a key. The monitor's read endpoints (overview, cases, evidence, dead letters) are public so the dashboard and the "Open case" link work without logging in. That is acceptable here only because all the data is simulated. Real player data would need login and role-based access. Decisions, resets and settings do need a key.
- n8n editor changes are overwritten on redeploy unless they are exported to the repository through `scripts/build-n8n-workflows.ts`.
- Slack buttons need a Slack app with interactivity and a signing secret (chapter 07). Without it, reviews happen in the dashboard.
- Baselines come from 20 simulated matches, not real history.
- A database outage longer than the ingestion retries (5 tries, 3 seconds apart, about 15 seconds) loses the events sent during it, because n8n has already answered the simulator and the dead letter cannot be written without the database.
- The public n8n address also exposes `/webhook/telemetry`. Requests without the right token are rejected and recorded as dead letters, so a stranger could add noise to the dead-letter list but cannot add events.
- The market on its own can reach at most 30 (Monitor) with the default thresholds, so an unexplained odds move alone is shown on the Risk tab but never opens a case.
- The ingestion workflow does not keep successful executions in n8n's history, to save space; failures are kept.
