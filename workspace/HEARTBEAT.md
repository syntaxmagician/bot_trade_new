# HEARTBEAT.md

# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.

## Trading (pump.fun daemon)

If `trading/` exists, in heartbeat turns optionally:

1. Read `trading/state.json` — note `lastError`, today's counters, `daemon.status`.
2. If `trading/PAUSE` exists, remind the human that **new entries are paused**.
3. Skim last lines of `trading/signals.jsonl` (recent skips / `would_buy`) and summarize only if useful.

Do **not** invent keys or on-chain execution from chat; policy lives in `trading/policy.json`.
