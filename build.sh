#!/usr/bin/env bash
set -euo pipefail

eval "$(op signin)"

op run --env-file=.env -- npm run build:frontend

printf '%s\n' '[build.sh] Starting Docker Compose in attached mode; the command will keep streaming service logs while the stack is running.'

exec op run --env-file=.env -- docker compose up --build
