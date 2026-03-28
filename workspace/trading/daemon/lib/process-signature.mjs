import fs from "fs";
import { evaluateRedFlags, findPumpBuyInTx } from "./pump-analyze.mjs";
import { paths } from "./paths.mjs";
import { runWalletIntelligence } from "./wallet-intelligence.mjs";

/**
 * Fetch one tx; if it is a pump buy ≥ minBuySol, run red flags and build pipeline object.
 * @returns {Promise<{ pipeline: object } | { quiet: true, reason: string, detail?: unknown }>}
 */
export async function buildPipelineForSignature(connection, policy, signature, meta) {
  const now = new Date().toISOString();
  const pauseName = policy.safety?.pauseRelativeToTradingDir ?? "PAUSE";
  const paused = fs.existsSync(paths.pauseFile(pauseName));
  const pumpProgramIdStr = policy.chain.pumpProgramId;
  const minBuySol = policy.whaleSignal?.minBuySol ?? 2;
  const minBuyLamports = BigInt(Math.floor(minBuySol * 1e9));
  const skipIfGte = policy.safety?.skipIfRedFlagsGte ?? 2;

  let slot = 0;
  try {
    slot = await connection.getSlot("confirmed");
  } catch {
    /* ignore */
  }

  const parsed = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!parsed) {
    return { quiet: true, reason: "tx_null", detail: { signature } };
  }
  if (parsed.meta?.err) {
    return { quiet: true, reason: "tx_err", detail: { signature, err: parsed.meta.err } };
  }

  const buy = findPumpBuyInTx(pumpProgramIdStr, parsed);
  if (!buy) {
    return { quiet: true, reason: "no_pump_buy_ix" };
  }

  const solEst = Number(buy.solLamportsApprox) / 1e9;
  if (buy.solLamportsApprox < minBuyLamports) {
    return {
      quiet: true,
      reason: "below_min_buy_sol",
      detail: { signature, solEst, minBuySol },
    };
  }

  const whaleMeta = {
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

  const evalResult = await evaluateRedFlags(connection, policy, whaleMeta);
  const flags = evalResult.hits.map((h) => h.flag);
  const hardSkipFlags = new Set(policy.safety?.hardSkipFlags ?? ["wallet_dev_or_dumper"]);
  const shouldSkipByHardFlag = flags.some((f) => hardSkipFlags.has(f));
  let shouldSkip = shouldSkipByHardFlag || flags.length >= skipIfGte || paused;

  /** Analisis wallet pembeli awal — hanya jika belum skip (hemat RPC). */
  let wi = null;
  if (!shouldSkip && policy.walletIntelligence?.enabled) {
    try {
      wi = await runWalletIntelligence(connection, policy, whaleMeta);
    } catch (e) {
      wi = {
        enabled: true,
        mix: { ok: false, error: String(e?.message ?? e) },
        adjustment: {
          walletScore: 0,
          entryScore: policy.walletIntelligence?.signalScore ?? 1,
          positionSizeMultiplier: 1,
          skip: false,
        },
        logText: "",
        rpcError: String(e?.message ?? e),
      };
    }
    if (wi?.adjustment?.skip) {
      shouldSkip = true;
    }
  }

  const wiCfg = policy.walletIntelligence ?? {};
  const defaultSignal = wiCfg.signalScore ?? 1;
  const entryScore =
    wi?.enabled && wi.adjustment
      ? wi.adjustment.entryScore
      : defaultSignal;

  const action = paused ? "skip_paused" : shouldSkip ? "skip" : "would_buy";

  const pipeline = {
    ts: now,
    kind: meta.pipelineKind ?? "scout_pipeline",
    source: meta.source ?? "signature",
    slot,
    paused,
    pumpProgramId: pumpProgramIdStr,
    whale: whaleMeta,
    redFlagCount: flags.length,
    redFlags: flags,
    hardSkipFlagsTriggered: flags.filter((f) => hardSkipFlags.has(f)),
    redFlagDetails: evalResult.byFlag,
    notes: evalResult.notes ?? [],
    action,
    executionMode: policy.execution?.mode ?? "log_only",
    signalScore: defaultSignal,
    entryScore,
    walletIntelligence: wi
      ? {
          enabled: wi.enabled,
          skippedByRatio: wi.adjustment?.skip === true,
          skipReason: wi.adjustment?.reason ?? null,
          walletScore: wi.adjustment?.walletScore ?? 0,
          positionSizeMultiplier: wi.adjustment?.positionSizeMultiplier ?? 1,
          smartRatio: wi.mix?.smartRatio,
          sniperRatio: wi.mix?.sniperRatio,
          dumperRatio: wi.mix?.dumperRatio,
          rpcError: wi.rpcError ?? null,
          logText: wi.logText ?? "",
        }
      : { enabled: false, logText: "" },
  };

  return { pipeline, whaleMeta, shouldSkip };
}

export function bumpStateForPipeline(state, result) {
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (state.today?.dateUtc !== todayUtc) {
    state.today = {
      dateUtc: todayUtc,
      signalsSeen: 0,
      skipped: 0,
      wouldBuy: 0,
      executedBuys: 0,
      paperBuys: 0,
      errors: 0,
      scoutRuns: 0,
      streamEvents: 0,
    };
  }
  if (!("streamEvents" in state.today)) state.today.streamEvents = 0;

  state.today.signalsSeen = (state.today.signalsSeen ?? 0) + 1;
  if (result.shouldSkip) {
    state.today.skipped = (state.today.skipped ?? 0) + 1;
  } else {
    state.today.wouldBuy = (state.today.wouldBuy ?? 0) + 1;
  }
}
