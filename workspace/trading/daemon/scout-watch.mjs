/**
 * Real-time: pump program → throttle → getParsedTransaction → whale + red-flag pipeline.
 *
 * Transport (policy.watch.transport):
 * - websocket: logsSubscribe — but banyak RPC (termasuk Alchemy Solana) tidak expose logsSubscribe di WS → error -32601.
 * - poll (default): HTTP getSignaturesForAddress — kompatibel Alchemy.
 *
 * Env: daemon/.env (ALCHEMY_API_KEY) atau shell. npm run watch
 */

import "./lib/load-env.mjs";
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import {
  buildAlchemyHttpConnection,
  buildAlchemyWatchConnection,
  rpcDisplayHost,
} from "./lib/alchemy-connection.mjs";
import { startPumpSignaturePoll } from "./lib/pump-signature-poller.mjs";
import {
  buildPipelineForSignature,
  bumpStateForPipeline,
} from "./lib/process-signature.mjs";
import { appendSignal, paths, readJson, stringifyJson, writeState } from "./lib/paths.mjs";

const policy = readJson(paths.policy);
const watch = policy.watch ?? {};
const watchTransport = watch.transport ?? "poll";
const connection =
  watchTransport === "websocket"
    ? buildAlchemyWatchConnection(policy)
    : buildAlchemyHttpConnection(policy);
const pumpKey = new PublicKey(policy.chain.pumpProgramId);
const pauseName = policy.safety?.pauseRelativeToTradingDir ?? "PAUSE";

const minIntervalMs = watch.minIntervalMs ?? 220;
const sigPollMs = watch.pollIntervalMs ?? 2500;
const sigPollLimit = watch.pollSignatureLimit ?? policy.scan?.fetchSignatureLimit ?? 30;
const maxQueue = watch.maxQueue ?? 500;
const maxSeen = watch.maxSeenSignatures ?? 8000;
/** If true, log every skipped decode reason (noisy). */
const logQuiet = watch.logQuietReasons === true;

let state;
try {
  state = readJson(paths.state);
} catch {
  state = { updatedAt: null, daemon: {}, today: {}, openPositions: [], lastError: null };
}

const seen = new Set();
const queue = [];
let workerRunning = false;

function rememberSignature(sig) {
  if (seen.has(sig)) return false;
  if (seen.size >= maxSeen) {
    const first = seen.values().next().value;
    seen.delete(first);
  }
  seen.add(sig);
  return true;
}

function enqueue(sig) {
  if (!sig || !rememberSignature(sig)) return;
  if (queue.length >= maxQueue) queue.shift();
  queue.push(sig);
  void runWorker();
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length > 0) {
      const signature = queue.shift();

      try {
        const result = await buildPipelineForSignature(connection, policy, signature, {
          pipelineKind: "scout_pipeline_stream",
          source: watchTransport === "poll" ? "pollSignatures" : "logsSubscribe",
        });

        if ("quiet" in result && result.quiet) {
          if (logQuiet) {
            console.log(
              "[watch quiet]",
              signature.slice(0, 12) + "…",
              result.reason,
              result.detail ? stringifyJson(result.detail) : ""
            );
          }
        } else {
          bumpStateForPipeline(state, result);
          const now = new Date().toISOString();
          state.updatedAt = now;
          state.today.streamEvents = (state.today.streamEvents ?? 0) + 1;
          state.daemon = {
            ...state.daemon,
            status: "watch_ok",
            lastHeartbeatAt: now,
            paused: fs.existsSync(paths.pauseFile(pauseName)),
            rpcHost: rpcDisplayHost(policy),
          };
          state.lastError = null;
          appendSignal(result.pipeline);
          writeState(state);

          const wiLog = result.pipeline.walletIntelligence?.logText;
          if (wiLog) {
            console.log(wiLog);
          }

          const w = result.pipeline.whale;
          console.log(
            "[watch]",
            result.pipeline.action,
            w.signature.slice(0, 16) + "…",
            "~",
            w.solEstimateFromIx,
            "SOL | flags:",
            result.pipeline.redFlags.length,
            result.pipeline.redFlags
          );
        }
      } catch (e) {
        const msg = e?.message ?? String(e);
        state.lastError = { at: new Date().toISOString(), message: msg };
        state.today.errors = (state.today.errors ?? 0) + 1;
        writeState(state);
        console.error("[watch] error:", msg);
      }

      await new Promise((r) => setTimeout(r, minIntervalMs));
    }
  } finally {
    workerRunning = false;
    if (queue.length > 0) void runWorker();
  }
}

/** @type {number | null} */
let wsSubId = null;
/** @type {null | (() => void)} */
let stopSigPoll = null;

if (watchTransport === "websocket") {
  wsSubId = connection.onLogs(
    pumpKey,
    (logInfo) => {
      const sig = logInfo?.signature;
      if (sig) enqueue(sig);
    },
    "confirmed"
  );
  console.log("scout-watch: transport websocket | logsSubscribe id", wsSubId);
} else {
  stopSigPoll = startPumpSignaturePoll({
    connection,
    pumpProgramKey: pumpKey,
    rememberSignature,
    enqueue,
    pollIntervalMs: sigPollMs,
    limit: sigPollLimit,
  });
  console.log("scout-watch: transport poll | every", sigPollMs, "ms | limit", sigPollLimit);
}

console.log("  throttle:", minIntervalMs, "ms | queue max:", maxQueue, "| host:", rpcDisplayHost(policy));
console.log("  Ctrl+C to stop");

async function shutdown() {
  try {
    if (stopSigPoll) stopSigPoll();
    if (wsSubId != null) await connection.removeOnLogsListener(wsSubId);
  } catch (e) {
    console.error("unsubscribe:", e?.message ?? e);
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
