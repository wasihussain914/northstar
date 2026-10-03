#!/usr/bin/env bash
# Start the API (port 8000) and the web app (port 5173) together.
set -euo pipefail
cd "$(dirname "$0")"

(cd backend && uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload) &
API=$!
trap 'kill $API 2>/dev/null' EXIT

cd frontend
[ -d node_modules ] || npm install
npm run dev
