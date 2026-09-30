#!/bin/sh
# Imports the repository's workflows, publishes them, then starts n8n in the foreground.
# Importing the same workflow ID again updates it in place, so edits made in the n8n editor
# are replaced by the repository version on the next deploy. Export changes back to the repo.
set -e

WORKFLOWS=/opt/group13/workflows

if ls "$WORKFLOWS"/*.json >/dev/null 2>&1; then
  echo "group13: importing workflows from $WORKFLOWS"
  n8n import:workflow --separate --input="$WORKFLOWS"
  for file in "$WORKFLOWS"/*.json; do
    id=$(node -e "process.stdout.write(String(require(process.argv[1]).id || ''))" "$file")
    if [ -n "$id" ]; then
      echo "group13: publishing workflow $id"
      n8n publish:workflow --id="$id" || echo "group13: could not publish $id (continuing)"
    fi
  done
else
  echo "group13: no workflows to import"
fi

exec n8n start
