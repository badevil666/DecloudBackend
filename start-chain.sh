#!/bin/bash
# Start the local blockchain with persistent state.
# State is saved to .anvil-state.json on exit and reloaded on restart.
# First time: run this, then run: node scripts/deploy-local.js
# After that: just run this — everything is restored automatically.

STATE_FILE="$(dirname "$0")/.anvil-state.json"

if [ -f "$STATE_FILE" ]; then
  echo "Loading saved chain state from $STATE_FILE"
else
  echo "No saved state found — starting fresh (run deploy-local.js after this)"
fi

anvil \
  --mnemonic "test test test test test test test test test test test junk" \
  --chain-id 31337 \
  --state "$STATE_FILE" \
  --host 0.0.0.0
