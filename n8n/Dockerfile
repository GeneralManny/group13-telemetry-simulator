# n8n for the Group 13 integrity monitor. Pinned version; bump deliberately.
FROM n8nio/n8n:2.41.4

# Workflows live in the repo (n8n/workflows/*.json) and are imported and published on every
# start, so the repository is the source of truth. Secrets are never in these files: workflows
# read them from environment variables through $env.
COPY --chown=node:node workflows /opt/group13/workflows
COPY --chown=node:node start.sh /opt/group13/start.sh

USER node
ENTRYPOINT ["/bin/sh", "/opt/group13/start.sh"]
