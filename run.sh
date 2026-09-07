#!/usr/bin/env bash
# Loads secrets from .env (git-ignored) into the environment of ONLY this
# script's child process — not your interactive shell. This means tools
# that read your shell's persistent environment (editors, AI coding
# assistants with terminal access, other long-lived processes) never see
# these values, unlike `export DEEPSEEK_API_KEY=...` in your shell profile.
#
# Usage (from the project root):
#   ./run.sh :chat-module:bootRun
#   ./run.sh :tools-module:bootRun
#   ./run.sh :rag-module:bootRun
#   ./run.sh :agent-module:bootRun
#   ./run.sh :structured-output-module:bootRun
#
# Or any other gradle command — everything after ./run.sh is forwarded
# to gradle as-is.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $ENV_FILE"
  echo "Copy .env.example to .env and fill in your real API key first:"
  echo "  cp .env.example .env"
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: ./run.sh <gradle-task>   e.g. ./run.sh :chat-module:bootRun"
  exit 1
fi

# 'set -a' auto-exports every variable sourced below, but ONLY within this
# script's own process and whatever it launches (gradle) — it does not
# persist in your parent interactive shell once the script exits.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Prefer the project's own Gradle wrapper (./gradlew) if it's been
# generated (see README's `gradle wrapper --gradle-version 9.0` step) —
# falls back to a globally installed `gradle` otherwise.
if [ -x "$SCRIPT_DIR/gradlew" ]; then
  exec "$SCRIPT_DIR/gradlew" "$@"
else
  exec gradle "$@"
fi
