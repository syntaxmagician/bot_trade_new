/**
 * Scout pipeline: RPC check → recent pump.fun txs → whale buy gate → red flags → log.
 * HTTP + Bearer (key not in URL). For live stream use scout-watch.mjs.
 */

import "./lib/load-env.mjs";
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import { buildAlchemyHttpConnection, rpcDisplayHost } from "./lib/alchemy-connection.mjs";
import { appendSignal, paths, readJson, writeState } from "./lib/paths.mjs";
import {
  evaluateRedFlags,
  findPumpBuyInTx,
} from "./lib/pump-analyze.mjs";

const policy = readJson(paths.policy);
const connection = buildAlchemyHttpConnection(policy);
const pumpProgramIdStr = policy.chain.pumpProgramId;
const pumpProgramKey = new PublicKey(pumpProgramIdStr);
const pauseName = policy.safety?.pauseRelativeToTradingDir ?? "PAUSE";
const paused = fs.existsSync(paths.pauseFile(pauseName));

const scanLimit = policy.scan?.fetchSignatureLimit ?? 25;
const decodeLimit = policy.scan?.maxTransactionsToDecode ?? 15;
const minBuySol = policy.whaleSignal?.minBuySol ?? 2;
const minBuyLamports = BigInt(Math.floor(minBuySol * 1e9));
const skipIfGte = policy.safety?.skipIfRedFlagsGte ?? 2;

const now = new Date().toISOString();

let state;
try {
  state = readJson(paths.state);
} catch {
  state = { updatedAt: null, daemon: {}, today: {}, openPositions: [], lastError: null };
}

try {
  const slot = await connection.getSlot("confirmed");
  const sigInfos = await connection.getSignaturesForAddress(pumpProgramKey, {
    limit: scanLimit,
  });

  const todayUtc = now.slice(0, 10);
  if (state.today?.dateUtc !== todayUtc) {
    state.today = {
      dateUtc: todayUtc,
      signalsSeen: 0,
      skipped: 0,
      wouldBuy: 0,
      executedBuys: 0,
      errors: 0,
      scoutRuns: 0,
    };
  }
  state.today.scoutRuns = (state.today.scoutRuns ?? 0) + 1;

  let whaleMeta = null;
  let scannedTx = 0;
  const errorsWhileDecoding = [];
  let buyInstructionsSeen = 0;
  let maxBuySolInBatch = 0;
  let maxBuySolSignature = null;

  for (const { signature, err } of sigInfos) {
    if (scannedTx >= decodeLimit) break;
    if (err) continue;
    scannedTx += 1;

    let parsed;
    try {
      parsed = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch (e) {
      errorsWhileDecoding.push({ signature, message: e?.message ?? String(e) });
      continue;
    }

    if (!parsed || parsed.meta?.err) continue;

    const buy = findPumpBuyInTx(pumpProgramIdStr, parsed);
    if (!buy) continue;

    buyInstructionsSeen += 1;
    const solEst = Number(buy.solLamportsApprox) / 1e9;
    if (solEst > maxBuySolInBatch) {
      maxBuySolInBatch = solEst;
      maxBuySolSignature = signature;
    }

    if (buy.solLamportsApprox < minBuyLamports) continue;

    whaleMeta = {
      signature,
      mint: buy.mint,
      user: buy.user,
      bondingCurve: buy.bondingCurve,
      buyKind: buy.kind,
      solEstimateFromIx: solEst,
      solEstimateSource: buy.solEstimateSource,
      maxSolCostSol:
        buy.maxSolCostLamports != null ? Number(buy.maxSolCostLamports) / 1e9 : undefined,
      tokenAmountRaw: buy.tokenAmount?.toString?.() ?? "0",
    };
    break;
  }

  state.updatedAt = now;
  state.daemon = {
    ...state.daemon,
    status: "scout_ok",
    lastHeartbeatAt: now,
    paused,
    rpcHost: rpcDisplayHost(policy),
  };
  state.lastError = null;

  let pipeline = {
    ts: now,
    kind: "scout_pipeline",
    source: "batch_poll",
    slot,
    paused,
    pumpProgramId: pumpProgramIdStr,
    scan: {
      signatureCandidates: sigInfos.length,
      transactionsDecoded: scannedTx,
      errorsWhileDecoding,
      buyInstructionsSeen,
      maxBuySolInBatch: maxBuySolInBatch > 0 ? maxBuySolInBatch : null,
      maxBuySolSignature,
      minBuySolRequired: minBuySol,
    },
    whale: null,
    redFlagCount: 0,
    redFlags: [],
    redFlagDetails: {},
    notes: [],
    action: "no_whale_buy_seen",
    executionMode: policy.execution?.mode ?? "log_only",
  };

  if (whaleMeta) {
    state.today.signalsSeen = (state.today.signalsSeen ?? 0) + 1;
    const evalResult = await evaluateRedFlags(connection, policy, whaleMeta);
    const flags = evalResult.hits.map((h) => h.flag);
    pipeline.notes = evalResult.notes ?? [];
    pipeline.whale = whaleMeta;
    pipeline.redFlags = flags;
    pipeline.redFlagCount = flags.length;
    pipeline.redFlagDetails = evalResult.byFlag ?? {};
    const shouldSkip = pipeline.redFlagCount >= skipIfGte || paused;

    if (shouldSkip) {
      pipeline.action = paused ? "skip_paused" : "skip";
      state.today.skipped = (state.today.skipped ?? 0) + 1;
    } else {
      pipeline.action = "would_buy";
      state.today.wouldBuy = (state.today.wouldBuy ?? 0) + 1;
    }
  }

  writeState(state);
  appendSignal(pipeline);

  console.log("Scout OK");
  console.log("  Slot:", slot);
  console.log("  Paused:", paused);
  console.log("  Signatures fetched:", sigInfos.length, "| txs decoded:", scannedTx);
  console.log(
    "  Whale buy (>=",
    minBuySol,
    "SOL):",
    whaleMeta ? `${whaleMeta.signature.slice(0, 16)}…` : "none this pass"
  );
  if (!whaleMeta && buyInstructionsSeen > 0) {
    console.log(
      "  Diagnostics: pump buys in batch:",
      buyInstructionsSeen,
      "| largest ~",
      maxBuySolInBatch.toFixed(4),
      "SOL — turunkan whaleSignal.minBuySol jika mau ikut posisi lebih kecil"
    );
  }
  if (!whaleMeta && buyInstructionsSeen === 0) {
    console.log(
      "  Diagnostics: tidak ada ix buy pump di tx yang di-decode (banyak create/sell/migrate/non-buy di jendela ini)."
    );
  }
  if (whaleMeta) {
    console.log("  Action:", pipeline.action, "| red flags:", pipeline.redFlagCount, pipeline.redFlags);
  }
  console.log("  Updated:", paths.state);
  console.log("  Logged:", paths.signals);
} catch (err) {
  state.updatedAt = now;
  state.daemon = {
    ...state.daemon,
    status: "scout_error",
    lastHeartbeatAt: now,
  };
  state.lastError = {
    at: now,
    message: err?.message ?? String(err),
  };
  state.today = state.today ?? {};
  state.today.errors = (state.today.errors ?? 0) + 1;
  writeState(state);
  console.error("Scout failed:", err?.message ?? err);
  if (String(err?.message ?? err).includes("401")) {
    console.error(`
401 hints:
  • Use ALCHEMY_API_KEY in this shell (scout now sends Bearer to .../v2).
  • In dashboard: app must include Solana + Mainnet (same key).
  • Copy the full API key (no spaces). Rotate key if it was leaked.
  • If you set SOLANA_RPC_URL, it must be a valid Alchemy Solana URL with a working key.
`);
  }
  process.exit(1);
}
