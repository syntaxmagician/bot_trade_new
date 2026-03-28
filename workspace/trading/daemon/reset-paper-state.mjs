/**
 * Reset workspace/trading/state.json ke awal (paper: saldo awal, posisi kosong, stat 0).
 * Jalankan dari folder daemon: npm run reset-state
 */

import "./lib/load-env.mjs";
import fs from "fs";
import { paths, readJson, stringifyJson } from "./lib/paths.mjs";

const policy = readJson(paths.policy);
const exec = policy.execution ?? {};
const paperInitialBalanceSol = Number(exec.paperInitialBalanceSol ?? 5);
const virtualLamports = BigInt(Math.floor(paperInitialBalanceSol * 1e9));

const todayUtc = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

const state = {
  updatedAt: now,
  daemon: {
    status: "idle",
    lastHeartbeatAt: now,
    paused: false,
    rpcHost: "—",
  },
  today: {
    dateUtc: todayUtc,
    signalsSeen: 0,
    skipped: 0,
    wouldBuy: 0,
    executedBuys: 0,
    paperBuys: 0,
    errors: 0,
    scoutRuns: 0,
    streamEvents: 0,
  },
  openPositions: [],
  lastError: null,
  paper: {
    virtualSolLamports: virtualLamports.toString(),
    positions: [],
    wins: 0,
    losses: 0,
    breakeven: 0,
    totalRealizedPnlLamports: "0",
  },
};

fs.writeFileSync(paths.state, stringifyJson(state, 2) + "\n", "utf8");
console.log(
  "Reset state →",
  paths.state,
  "| paper",
  paperInitialBalanceSol,
  "SOL | hari",
  todayUtc
);
