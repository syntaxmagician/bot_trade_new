/**
 * Radar WSS (logsSubscribe pump program) → decode whale buy → red flags → optional Jupiter copy-buy → TP/SL polling.
 * Telegram tidak disertakan.
 *
 * Exit dua mode (policy.whaleFollow.exitMode):
 * - jupiter_quote: TP/SL dari perkiraan SOL keluar (quote Jupiter) vs SOL masuk (seperti sebelumnya).
 * - mcap_sol: TP/SL dari MCAP bonding curve (tanpa partial modal di kode ini).
 * - jupiter_quote + recoverModalFirst (legacy): sekali — quote penuh > entry×(1+recoverModalMinGainPct/100) dengan anchor entry;
 *   partial tarik ~recoverModalPctOfEntrySol% entry SOL. Sisa: remainderTakeProfitPct vs baseline sisa + trailing + SL sisa.
 *   SL penuh sebelum partial: stopLossPct vs entry.
 * - stale chart (policy.whaleFollow.staleChartExitMs): jika MCAP bonding curve atau fallback quote
 *   tidak bergerak lebih dari staleChartMovePct % dari anchor selama sekian ms → exit (coin mati).
 *
 * Eksekusi nyata:
 *   - policy.execution.mode = "execute"
 *   - $env:TRADING_WALLET_SECRET = private key base58 (64-byte secret)
 *   - Isi SOL di wallet itu untuk swap + fee
 *
 * Mode aman default: log_only (sama seperti scout; tidak kirim tx).
 *
 * Paper trading:
 *   - policy.execution.mode = "paper"
 *   - Quote Jupiter + aturan TP/SL sama; tidak kirim tx; saldo SOL virtual (paperInitialBalanceSol).
 *   - state.paper: posisi, virtualSolLamports, wins/losses, totalRealizedPnlLamports (lihat state.json).
 *
 * Env: isi daemon/.env (ALCHEMY_API_KEY, JUPITER_API_KEY, SOLSCAN_API_KEY untuk cek Creator vs buyer, dll.) — dimuat otomatis. Atau set di shell.
 * PowerShell contoh:
 *   $env:TRADING_WALLET_SECRET="..."
 *   npm run follow
 */

import "./lib/load-env.mjs";
import fs from "fs";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildAlchemyHttpConnection,
  buildAlchemyWatchConnection,
  rpcDisplayHost,
} from "./lib/alchemy-connection.mjs";
import { startPumpSignaturePoll } from "./lib/pump-signature-poller.mjs";
import { buildPipelineForSignature, bumpStateForPipeline } from "./lib/process-signature.mjs";
import { jupiterQuoteV6, jupiterSwapV6, SOL_MINT } from "./lib/jupiter-swap.mjs";
import { getPumpBondingCurveMcapSol } from "./lib/pump-mcap.mjs";
import { getWalletTokenRawAmount } from "./lib/wallet-token.mjs";
import { appendSignal, paths, readJson, stringifyJson, writeState } from "./lib/paths.mjs";

const policy = readJson(paths.policy);
const watchCfg = policy.watch ?? {};
const watchTransport = watchCfg.transport ?? "poll";
const connection =
  watchTransport === "websocket"
    ? buildAlchemyWatchConnection(policy)
    : buildAlchemyHttpConnection(policy);
const pumpKey = new PublicKey(policy.chain.pumpProgramId);
const pauseName = policy.safety?.pauseRelativeToTradingDir ?? "PAUSE";
const sigPollMs = watchCfg.pollIntervalMs ?? 2500;
const sigPollLimit = watchCfg.pollSignatureLimit ?? policy.scan?.fetchSignatureLimit ?? 30;

const exec = policy.execution ?? {};
const mode = exec.mode ?? "log_only";
const isPaper = mode === "paper";
const paperInitialBalanceSol = exec.paperInitialBalanceSol ?? 5;
const maxOpenPositions = exec.maxOpenPositions ?? 2;
const maxBuySol = exec.maxBuySolPerTrade ?? 0.05;
const slippageBps = exec.slippageBps ?? 500;

const wf = policy.whaleFollow ?? {};
const exitMode = wf.exitMode ?? "jupiter_quote";
const takeProfitPct = wf.takeProfitPct ?? 50;
const stopLossPct = wf.stopLossPct ?? 30;
const takeProfitMcapSol = wf.takeProfitMcapSol ?? null;
const takeProfitMcapMultiple = wf.takeProfitMcapMultiple ?? null;
const takeProfitMcapPctFromEntry = wf.takeProfitMcapPctFromEntry ?? null;
const stopLossMcapSol = wf.stopLossMcapSol ?? null;
const stopLossMcapFractionOfEntry = wf.stopLossMcapFractionOfEntry ?? null;
const stopLossMcapPctFromEntry = wf.stopLossMcapPctFromEntry ?? null;
const trailingStopPctFromPeak = wf.trailingStopPctFromPeak ?? null;
/** Hanya dipakai jika exitMode=mcap_sol dan tidak ada TP/SL eksplisit di atas — relatif ke entry MCAP. */
const defaultTakeProfitMcapMultiple = wf.defaultTakeProfitMcapMultiple ?? 2.5;
const defaultStopLossMcapFractionOfEntry = wf.defaultStopLossMcapFractionOfEntry ?? 0.5;
const minEntryMcapSol = wf.minEntryMcapSol ?? null;
const maxEntryMcapSol = wf.maxEntryMcapSol ?? null;
const mcapSolScale = wf.mcapSolScale ?? 1;
const pollIntervalMs = wf.pollIntervalMs ?? 8000;
const lamportsReserve = BigInt(wf.lamportsReserveForFees ?? 15_000_000);
/** Jika true: fase1 jual parsial untuk tarik modal (SOL) saat quote penuh > entry; sisa pakai TP/trailing. */
const recoverModalFirst = wf.recoverModalFirst !== false;
const logPaperExitPoll = wf.logPaperExitPoll === true;
/**
 * 0 = nonaktif. Default 120_000 ms jika tidak diisi.
 * Keluar jika MCAP bonding curve (atau fallback: estimasi SOL dari quote Jupiter) tidak bergerak
 * lebih dari staleChartMovePct % dari anchor selama sekian ms (chart "mati").
 */
const staleChartExitMs =
  wf.staleChartExitMs == null ? 120000 : Math.max(0, Number(wf.staleChartExitMs));
const staleChartMovePct = Math.max(0.1, Number(wf.staleChartMovePct ?? 2));
/** Throttle log error Jupiter berulang (NO_ROUTES_FOUND, TOKEN_NOT_TRADABLE, …) per mint (ms). 0 = selalu log. */
const quoteExitWarnThrottleMs =
  wf.quoteExitWarnThrottleMs == null ? 120_000 : Math.max(0, Number(wf.quoteExitWarnThrottleMs));

/** Kode error yang sama tiap poll — jangan spam terminal. */
const JUPITER_EXIT_QUOTE_THROTTLE_CODES = new Set(["NO_ROUTES_FOUND", "TOKEN_NOT_TRADABLE"]);

/** @param {unknown} errRaw */
function jupiterQuoteFailureCode(errRaw) {
  const s = String(errRaw ?? "");
  try {
    const j = JSON.parse(s);
    if (j.errorCode === "NO_ROUTES_FOUND") return "NO_ROUTES_FOUND";
    if (/no routes found/i.test(String(j.error ?? ""))) return "NO_ROUTES_FOUND";
    if (j.errorCode === "TOKEN_NOT_TRADABLE") return "TOKEN_NOT_TRADABLE";
    if (/not tradable/i.test(String(j.error ?? ""))) return "TOKEN_NOT_TRADABLE";
    return String(j.errorCode ?? j.error ?? "UNKNOWN").slice(0, 80);
  } catch {
    return "TEXT";
  }
}

const exitQuoteWarnLast = new Map();

function clearExitQuoteWarnThrottle(mint) {
  exitQuoteWarnLast.delete(mint);
}

/**
 * @param {"paper"|"follow"} tag
 * @param {string} mint
 * @param {{ ok: false, error?: string, status?: number, hint?: string }} quoteFull
 */
function logExitQuoteFailed(tag, mint, quoteFull) {
  const errRaw = quoteFull.error ?? quoteFull.status ?? "";
  const code = jupiterQuoteFailureCode(errRaw);
  const throttleMs =
    JUPITER_EXIT_QUOTE_THROTTLE_CODES.has(code) && quoteExitWarnThrottleMs > 0
      ? quoteExitWarnThrottleMs
      : 0;
  const now = Date.now();
  if (throttleMs > 0) {
    const last = exitQuoteWarnLast.get(mint) ?? 0;
    if (now - last < throttleMs) return;
    exitQuoteWarnLast.set(mint, now);
  }
  const hintApi = quoteFull.hint ? " " + quoteFull.hint : "";
  if (code === "NO_ROUTES_FOUND") {
    console.warn(
      `[${tag}] exit quote failed`,
      mint.slice(0, 8),
      "— NO_ROUTES_FOUND: Jupiter tidak punya rute token→SOL (likuiditas habis / bonding-only / tidak routable). Posisi tetap terbuka; cek lagi nanti atau tutup manual." + hintApi
    );
  } else if (code === "TOKEN_NOT_TRADABLE") {
    console.warn(
      `[${tag}] exit quote failed`,
      mint.slice(0, 8),
      "— TOKEN_NOT_TRADABLE: Jupiter menolak swap untuk mint ini (kebijakan agregator / token diblokir / tidak diizinkan di router). Paper tidak bisa simulasi jual lewat Jupiter sampai status berubah; hapus posisi manual di state jika perlu." + hintApi
    );
  } else {
    console.warn(`[${tag}] exit quote failed`, mint.slice(0, 8), errRaw, hintApi);
  }
}

/**
 * Partial sekali (recoverModalFirst): trigger selalu vs entry (bukan vs baseline sisa), hanya jika belum modalRecovered.
 * - recoverModalMinGainPct: 0 = segera saat outFull > entry; >0 = outFull ≥ entry×(1+pct/100).
 * - recoverModalPctOfEntrySol: % entry SOL yang ditargetkan di slice (100 = tarik penuh modal).
 * remainderTakeProfitPct: null = tanpa TP % di sisa; angka = TP sisa vs baseline remainder (mis. 9.9 ≈ +9.9%); undefined = pakai takeProfitPct.
 */
const recoverModalMinGainPct =
  wf.recoverModalMinGainPct === undefined ? 0 : Number(wf.recoverModalMinGainPct);
const recoverModalPctOfEntrySol = Math.min(
  100,
  Math.max(1, Number(wf.recoverModalPctOfEntrySol ?? 100))
);
/** @type {number | null | undefined} */
const remainderTakeProfitPctCfg = wf.remainderTakeProfitPct;

/** Desimal token pump.fun untuk proxy SOL/token (bisa override policy.whaleFollow.pumpTokenDecimals). */
const pumpTokenDecimals = Number(wf.pumpTokenDecimals ?? 6);

/** SOL per 1 token (unit UI) dari lamports SOL dan amount raw. */
function solPerTokenUi(solLamports, tokenRaw) {
  const s = typeof solLamports === "bigint" ? Number(solLamports) : Number(solLamports);
  const t = typeof tokenRaw === "bigint" ? Number(tokenRaw) : Number(tokenRaw);
  if (!Number.isFinite(s) || !Number.isFinite(t) || t <= 0) return null;
  const ui = t / 10 ** pumpTokenDecimals;
  return ui > 0 ? s / 1e9 / ui : null;
}

function formatSolPerTokenLabel(px) {
  if (px == null || !Number.isFinite(px)) return "?";
  if (px >= 1) return px.toFixed(6);
  if (px >= 1e-6) return px.toFixed(9);
  return px.toExponential(4);
}

/** TP dalam satuan MCAP (SOL): absolut, atau entry×multiple, atau entry×(1+pct/100), atau default multiple. */
function resolveTpMcapSol(pos) {
  if (takeProfitMcapSol != null) return takeProfitMcapSol;
  if (pos.entryMcapSol == null) return null;
  if (takeProfitMcapMultiple != null) return pos.entryMcapSol * takeProfitMcapMultiple;
  if (takeProfitMcapPctFromEntry != null) {
    return pos.entryMcapSol * (1 + takeProfitMcapPctFromEntry / 100);
  }
  if (exitMode === "mcap_sol") return pos.entryMcapSol * defaultTakeProfitMcapMultiple;
  return null;
}

/** SL dalam satuan MCAP (SOL): absolut, atau entry×fraction, atau entry×(1−pct/100), atau default fraction. */
function resolveSlMcapSol(pos) {
  if (stopLossMcapSol != null) return stopLossMcapSol;
  if (pos.entryMcapSol == null) return null;
  if (stopLossMcapFractionOfEntry != null) {
    return pos.entryMcapSol * stopLossMcapFractionOfEntry;
  }
  if (stopLossMcapPctFromEntry != null) {
    return pos.entryMcapSol * (1 - stopLossMcapPctFromEntry / 100);
  }
  if (exitMode === "mcap_sol") {
    return pos.entryMcapSol * defaultStopLossMcapFractionOfEntry;
  }
  return null;
}

function resolveJupiterQuoteExit(outLamports, entryLamports) {
  const tpLine = (entryLamports * BigInt(100 + takeProfitPct)) / 100n;
  const slLine = (entryLamports * BigInt(100 - stopLossPct)) / 100n;
  if (outLamports >= tpLine) return "take_profit";
  if (outLamports <= slLine) return "stop_loss";
  return null;
}

/** TP/SL fase sisa (setelah modal ditarik), relatif ke baseline SOL sisa. */
function resolveJupiterRemainderExit(outLamports, baselineLamports) {
  const slLine = (baselineLamports * BigInt(100 - stopLossPct)) / 100n;
  const rtp = remainderTakeProfitPctCfg;
  const tpPct = rtp === undefined ? takeProfitPct : rtp;
  if (tpPct != null) {
    const tpLine = (baselineLamports * BigInt(100 + Number(tpPct))) / 100n;
    if (outLamports >= tpLine) return "take_profit_remainder";
  }
  if (outLamports <= slLine) return "stop_loss_remainder";
  return null;
}

function resolveJupiterTrailingRemainder(outLamports, peakLamports, baselineLamports) {
  if (trailingStopPctFromPeak == null) return null;
  if (peakLamports <= (baselineLamports * 101n) / 100n) return null;
  if (outLamports < baselineLamports) return null;
  const floor = (peakLamports * BigInt(100 - trailingStopPctFromPeak)) / 100n;
  if (outLamports <= floor) return "trailing_stop_remainder";
  return null;
}

/** Syarat quote penuh untuk partial tarik modal (anchor = biasanya entry). */
function shouldTriggerRecoverModalPartial(outFullLamports, baselineLamports) {
  if (recoverModalMinGainPct <= 0) {
    return outFullLamports > baselineLamports;
  }
  const minOut = (baselineLamports * BigInt(100 + recoverModalMinGainPct)) / 100n;
  return outFullLamports >= minOut;
}

function recoverModalTargetSolLamports(entryLamports) {
  return (entryLamports * BigInt(recoverModalPctOfEntrySol)) / 100n;
}

/**
 * Chart "mati": tidak ada pergerakan relatif ≥ staleChartMovePct dari anchor selama staleChartExitMs.
 * Anchor di-reset saat harga (MCAP on-chain, atau fallback quote SOL) bergerak cukup jauh.
 */
async function maybeExitStaleChart(pos, outFullLamports, mode) {
  if (staleChartExitMs <= 0) return null;
  const positions = mode === "paper" ? state.paper?.positions : state.openPositions;
  if (!positions) return null;
  const idx = positions.findIndex((p) => p.mint === pos.mint);
  if (idx < 0) return null;

  const live = positions[idx];
  const now = Date.now();
  const bc = pos.bondingCurve ?? live.bondingCurve;

  if (bc) {
    const snap = await getPumpBondingCurveMcapSol(connection, bc, { mcapSolScale });
    if (snap.ok && !snap.complete && snap.mcapSol != null && snap.mcapSol > 0) {
      const mcap = snap.mcapSol;
      if (live.mcapFlatAnchorSol == null || live.mcapFlatSinceMs == null) {
        positions[idx].mcapFlatAnchorSol = mcap;
        positions[idx].mcapFlatSinceMs = now;
        state.updatedAt = new Date().toISOString();
        writeState(state);
        return null;
      }
      const anchor = live.mcapFlatAnchorSol;
      const since = live.mcapFlatSinceMs;
      const rel = Math.abs(mcap - anchor) / anchor;
      if (rel >= staleChartMovePct / 100) {
        positions[idx].mcapFlatAnchorSol = mcap;
        positions[idx].mcapFlatSinceMs = now;
        state.updatedAt = new Date().toISOString();
        writeState(state);
        return null;
      }
      if (now - since >= staleChartExitMs) {
        return "stale_chart";
      }
      return null;
    }
  }

  if (live.quoteFlatAnchorLamports == null || live.quoteFlatSinceMs == null) {
    positions[idx].quoteFlatAnchorLamports = outFullLamports.toString();
    positions[idx].quoteFlatSinceMs = now;
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return null;
  }
  const a = BigInt(live.quoteFlatAnchorLamports);
  if (a === 0n) return null;
  const diff = outFullLamports > a ? outFullLamports - a : a - outFullLamports;
  const relQ = Number(diff) / Number(a);
  if (relQ >= staleChartMovePct / 100) {
    positions[idx].quoteFlatAnchorLamports = outFullLamports.toString();
    positions[idx].quoteFlatSinceMs = now;
    state.updatedAt = new Date().toISOString();
    writeState(state);
    return null;
  }
  if (now - live.quoteFlatSinceMs >= staleChartExitMs) {
    return "stale_chart";
  }
  return null;
}

async function finalizeFullExit(pos, quoteResponse, reason, entryLamports, outLamports, exitTokenRawBal) {
  const swap = await jupiterSwapV6(connection, keypair, quoteResponse);
  if (!swap.ok) {
    console.error("[follow] exit swap failed", reason, swap);
    return false;
  }
  state.openPositions = state.openPositions.filter((p) => p.mint !== pos.mint);
  state.updatedAt = new Date().toISOString();
  writeState(state);
  clearExitQuoteWarnThrottle(pos.mint);
  const pnlPct = Number((outLamports * 10000n) / entryLamports - 10000n) / 100;
  const exitBal =
    exitTokenRawBal != null ? BigInt(exitTokenRawBal) : BigInt(pos.paperTokenRaw ?? 0);
  const exitPxUi = exitBal > 0n ? solPerTokenUi(outLamports, exitBal) : null;
  const entryPxUi =
    pos.entryAvgSolPerTokenUi != null && Number.isFinite(Number(pos.entryAvgSolPerTokenUi))
      ? Number(pos.entryAvgSolPerTokenUi)
      : exitBal > 0n
        ? solPerTokenUi(entryLamports, exitBal)
        : null;
  console.log(
    "[follow] SOLD",
    reason,
    pos.mint.slice(0, 8) + "…",
    "| harga_entry ~",
    formatSolPerTokenLabel(entryPxUi),
    "SOL/token | harga_jual ~",
    formatSolPerTokenLabel(exitPxUi),
    "SOL/token | ~",
    Number(outLamports) / 1e9,
    "SOL out | vs entry",
    Number(entryLamports) / 1e9,
    "SOL | ~",
    pnlPct.toFixed(1),
    "% | tx",
    swap.signature.slice(0, 16) + "…"
  );
  appendSignal({
    ts: new Date().toISOString(),
    kind: "whale_follow_exit",
    reason,
    mint: pos.mint,
    outSol: Number(outLamports) / 1e9,
    entrySol: Number(entryLamports) / 1e9,
    signature: swap.signature,
  });
  return true;
}

/** outThisExit = SOL dari exit ini saja; accumulated di pos untuk partial sebelumnya. */
function finalizePaperFullExit(pos, reason, outThisExitLamports) {
  ensurePaperState();
  const entryLamports = BigInt(pos.entrySolLamports);
  const accumulated = BigInt(pos.accumulatedSolOutLamports ?? 0);
  const totalOut = accumulated + outThisExitLamports;
  const pnl = totalOut - entryLamports;

  const idx = state.paper.positions.findIndex((p) => p.mint === pos.mint);
  if (idx < 0) return false;

  state.paper.virtualSolLamports = (BigInt(state.paper.virtualSolLamports) + outThisExitLamports).toString();
  state.paper.positions.splice(idx, 1);

  if (pnl > 0n) state.paper.wins += 1;
  else if (pnl < 0n) state.paper.losses += 1;
  else state.paper.breakeven += 1;

  state.paper.totalRealizedPnlLamports = (BigInt(state.paper.totalRealizedPnlLamports) + pnl).toString();
  state.updatedAt = new Date().toISOString();
  writeState(state);
  clearExitQuoteWarnThrottle(pos.mint);

  const pnlPct = Number((totalOut * 10000n) / entryLamports - 10000n) / 100;
  const closed =
    (state.paper.wins ?? 0) + (state.paper.losses ?? 0) + (state.paper.breakeven ?? 0);
  const winRate = closed > 0 ? (state.paper.wins / closed) * 100 : 0;

  const balExit = BigInt(pos.paperTokenRaw ?? 0);
  const exitPxUi = solPerTokenUi(outThisExitLamports, balExit);
  const entryPxStored = pos.entryAvgSolPerTokenUi;
  const entryPxUi =
    entryPxStored != null && Number.isFinite(Number(entryPxStored))
      ? Number(entryPxStored)
      : solPerTokenUi(entryLamports, balExit);

  console.log(
    "[paper] SOLD",
    reason,
    pos.mint.slice(0, 8) + "…",
    "| harga_entry ~",
    formatSolPerTokenLabel(entryPxUi),
    "SOL/token | harga_jual ~",
    formatSolPerTokenLabel(exitPxUi),
    "SOL/token | total out ~",
    Number(totalOut) / 1e9,
    "SOL vs entry",
    Number(entryLamports) / 1e9,
    "~",
    pnlPct.toFixed(1),
    "% | PnL",
    Number(pnl) / 1e9,
    "SOL"
  );
  console.log(
    "[paper] stats | W",
    state.paper.wins,
    "L",
    state.paper.losses,
    "BE",
    state.paper.breakeven,
    "| win%",
    winRate.toFixed(1),
    "| ΣPnL",
    Number(BigInt(state.paper.totalRealizedPnlLamports)) / 1e9,
    "SOL | virtual",
    Number(BigInt(state.paper.virtualSolLamports)) / 1e9,
    "SOL"
  );

  appendSignal({
    ts: new Date().toISOString(),
    kind: "whale_follow_paper_exit",
    reason,
    mint: pos.mint,
    totalOutSol: Number(totalOut) / 1e9,
    entrySol: Number(entryLamports) / 1e9,
    pnlSol: Number(pnl) / 1e9,
    wins: state.paper.wins,
    losses: state.paper.losses,
    winRatePct: winRate,
  });
  return true;
}

async function tryPaperBuyCopy(whaleMeta) {
  ensurePaperState();
  const mint = whaleMeta.mint;
  if (state.paper.positions.some((p) => p.mint === mint)) {
    return { ok: false, reason: "already_hold_mint" };
  }
  if (state.paper.positions.length >= maxOpenPositions) {
    return { ok: false, reason: "max_positions" };
  }

  let entryMcapSol = null;
  const mcapSnap = await getPumpBondingCurveMcapSol(connection, whaleMeta.bondingCurve, {
    mcapSolScale,
  });
  if (mcapSnap.ok && !mcapSnap.complete && mcapSnap.mcapSol != null) {
    entryMcapSol = mcapSnap.mcapSol;
    if (minEntryMcapSol != null && entryMcapSol < minEntryMcapSol) {
      return { ok: false, reason: "entry_mcap_too_low", mcapSol: entryMcapSol, min: minEntryMcapSol };
    }
    if (maxEntryMcapSol != null && entryMcapSol > maxEntryMcapSol) {
      return { ok: false, reason: "entry_mcap_too_high", mcapSol: entryMcapSol, max: maxEntryMcapSol };
    }
  }

  const virtualSol = BigInt(state.paper.virtualSolLamports);
  const maxLamports = BigInt(Math.floor(maxBuySol * 1e9));
  let spend = maxLamports < virtualSol - lamportsReserve ? maxLamports : virtualSol - lamportsReserve;
  if (spend <= 0n) {
    return { ok: false, reason: "insufficient_virtual_sol", virtual: state.paper.virtualSolLamports };
  }

  const quote = await jupiterQuoteV6(SOL_MINT, mint, spend, slippageBps);
  if (!quote.ok) {
    return { ok: false, reason: "quote_failed", detail: quote };
  }

  const tokenOut = BigInt(quote.data.outAmount);
  const inAmt = quote.data.inAmount != null ? String(quote.data.inAmount) : spend.toString();
  const spendLamports = BigInt(inAmt);
  const entryPxUi = solPerTokenUi(spendLamports, tokenOut);

  state.paper.virtualSolLamports = (virtualSol - spendLamports).toString();
  state.paper.positions.push({
    mint,
    bondingCurve: whaleMeta.bondingCurve,
    entrySolLamports: inAmt,
    paperTokenRaw: tokenOut.toString(),
    accumulatedSolOutLamports: "0",
    entryMcapSol: entryMcapSol ?? undefined,
    peakMcapSol: entryMcapSol ?? undefined,
    entryAvgSolPerTokenUi: entryPxUi ?? undefined,
    exitMode,
    modalRecovered: false,
    partialTpCount: 0,
    remainderBaselineSolLamports: undefined,
    peakSolRemainderLamports: undefined,
    whaleCopyOfSignature: whaleMeta.signature,
    openedAt: new Date().toISOString(),
  });
  state.today.paperBuys = (state.today.paperBuys ?? 0) + 1;
  state.updatedAt = new Date().toISOString();
  writeState(state);

  console.log(
    "[paper] BOUGHT",
    mint.slice(0, 8) + "…",
    "spend~",
    Number(inAmt) / 1e9,
    "SOL",
    "| harga_entry ~",
    formatSolPerTokenLabel(entryPxUi),
    "SOL/token",
    entryMcapSol != null ? "| mcap~ " + entryMcapSol.toFixed(2) + " SOL" : "",
    "| token(raw)~",
    tokenOut.toString().slice(0, 12) + "…",
    "| virtual left ~",
    Number(BigInt(state.paper.virtualSolLamports)) / 1e9,
    "SOL"
  );

  return { ok: true, entrySolLamports: inAmt };
}

async function tryPaperExitPosition(pos) {
  ensurePaperState();
  const bal = BigInt(pos.paperTokenRaw ?? 0);
  if (bal === 0n) {
    const idx = state.paper.positions.findIndex((p) => p.mint === pos.mint);
    if (idx >= 0) {
      const live = state.paper.positions[idx];
      const acc = BigInt(live.accumulatedSolOutLamports ?? 0);
      const entry = BigInt(live.entrySolLamports);
      const pnl = acc - entry;
      state.paper.positions.splice(idx, 1);
      if (pnl > 0n) state.paper.wins += 1;
      else if (pnl < 0n) state.paper.losses += 1;
      else state.paper.breakeven += 1;
      state.paper.totalRealizedPnlLamports = (BigInt(state.paper.totalRealizedPnlLamports) + pnl).toString();
      writeState(state);
      clearExitQuoteWarnThrottle(pos.mint);
      console.log("[paper] position removed (zero token bal)", pos.mint.slice(0, 8) + "…", "PnL~", Number(pnl) / 1e9);
    }
    return;
  }

  const quoteFull = await jupiterQuoteV6(pos.mint, SOL_MINT, bal, slippageBps);
  if (!quoteFull.ok) {
    logExitQuoteFailed("paper", pos.mint, quoteFull);
    return;
  }

  const outFull = BigInt(quoteFull.data.outAmount);
  const entry = BigInt(pos.entrySolLamports);
  const posExitMode = pos.exitMode ?? exitMode;

  const staleReasonPaper = await maybeExitStaleChart(pos, outFull, "paper");
  if (staleReasonPaper) {
    finalizePaperFullExit(pos, staleReasonPaper, outFull);
    return;
  }

  if (logPaperExitPoll) {
    const slLamports = (entry * BigInt(100 - stopLossPct)) / 100n;
    console.log(
      "[paper] exit check",
      pos.mint.slice(0, 8) + "…",
      "| quote→SOL ~",
      Number(outFull) / 1e9,
      "| entry",
      Number(entry) / 1e9,
      "| SL line ≤",
      Number(slLamports) / 1e9
    );
  }

  if (posExitMode === "mcap_sol" && pos.entryMcapSol != null) {
    let reason = null;
    const snap = await getPumpBondingCurveMcapSol(connection, pos.bondingCurve, { mcapSolScale });
    if (snap.ok && snap.complete) {
      reason = resolveJupiterQuoteExit(outFull, entry);
    } else if (snap.ok && snap.mcapSol != null) {
      const mcap = snap.mcapSol;
      const idx = state.paper.positions.findIndex((p) => p.mint === pos.mint);
      const live = idx >= 0 ? state.paper.positions[idx] : pos;
      const entryM = live.entryMcapSol;
      const peak = Math.max(live.peakMcapSol ?? entryM, mcap);
      if (idx >= 0 && peak !== live.peakMcapSol) {
        state.paper.positions[idx].peakMcapSol = peak;
        writeState(state);
      }

      const tpM = resolveTpMcapSol(live);
      const slM = resolveSlMcapSol(live);
      if (tpM != null && mcap >= tpM) reason = "take_profit_mcap";
      else if (slM != null && mcap <= slM) reason = "stop_loss_mcap";
      else if (
        trailingStopPctFromPeak != null &&
        entryM != null &&
        peak > entryM * 1.01 &&
        mcap >= entryM &&
        mcap <= peak * (1 - trailingStopPctFromPeak / 100)
      ) {
        reason = "trailing_stop_mcap";
      }
    } else {
      reason = resolveJupiterQuoteExit(outFull, entry);
    }
    if (!reason) return;
    finalizePaperFullExit(pos, reason, outFull);
    return;
  }

  if (posExitMode === "jupiter_quote" && recoverModalFirst) {
    const idx = state.paper.positions.findIndex((p) => p.mint === pos.mint);
    const live = idx >= 0 ? state.paper.positions[idx] : pos;

    if (outFull <= (entry * BigInt(100 - stopLossPct)) / 100n) {
      finalizePaperFullExit(pos, "stop_loss", outFull);
      return;
    }

    const alreadyPulledModal =
      live.modalRecovered === true ||
      (live.remainderBaselineSolLamports != null &&
        String(live.remainderBaselineSolLamports).length > 0);
    const canPartialRecover =
      !alreadyPulledModal && shouldTriggerRecoverModalPartial(outFull, entry);

    if (canPartialRecover && outFull > 0n) {
      const targetSol = recoverModalTargetSolLamports(entry);
      if (targetSol >= outFull) {
        finalizePaperFullExit(pos, "take_profit_full", outFull);
        return;
      }
      const partialBal = (bal * targetSol) / outFull;
      if (partialBal <= 0n) return;
      if (partialBal >= bal) {
        finalizePaperFullExit(pos, "take_profit_full", outFull);
        return;
      }
      const qPart = await jupiterQuoteV6(pos.mint, SOL_MINT, partialBal, slippageBps);
      if (!qPart.ok) return;
      const solOutPart = BigInt(qPart.data.outAmount);
      if (idx < 0) return;
      const newTokenBal = bal - partialBal;
      const prevAcc = BigInt(state.paper.positions[idx].accumulatedSolOutLamports ?? 0);
      state.paper.positions[idx].paperTokenRaw = newTokenBal.toString();
      state.paper.positions[idx].accumulatedSolOutLamports = (prevAcc + solOutPart).toString();
      state.paper.positions[idx].modalRecovered = true;
      state.paper.positions[idx].partialTpCount = (Number(live.partialTpCount) || 0) + 1;
      state.paper.virtualSolLamports = (BigInt(state.paper.virtualSolLamports) + solOutPart).toString();

      const qRem = await jupiterQuoteV6(pos.mint, SOL_MINT, newTokenBal, slippageBps);
      if (!qRem.ok) {
        writeState(state);
        return;
      }
      const remOut = BigInt(qRem.data.outAmount);
      state.paper.positions[idx].remainderBaselineSolLamports = remOut.toString();
      state.paper.positions[idx].peakSolRemainderLamports = remOut.toString();
      state.updatedAt = new Date().toISOString();
      writeState(state);
      const slicePxPaper = solPerTokenUi(solOutPart, partialBal);
      console.log(
        "[paper] partial TP",
        state.paper.positions[idx].partialTpCount,
        "— slice",
        recoverModalPctOfEntrySol + "% entry ~",
        Number(targetSol) / 1e9,
        "SOL (vs entry +",
        recoverModalMinGainPct + "%) | harga_slice ~",
        formatSolPerTokenLabel(slicePxPaper),
        "SOL/token | out ~",
        Number(solOutPart) / 1e9,
        "| sisa ~",
        Number(remOut) / 1e9,
        "SOL"
      );
      return;
    }

    if (live.remainderBaselineSolLamports == null || String(live.remainderBaselineSolLamports).length === 0) {
      return;
    }

    let baseline = BigInt(live.remainderBaselineSolLamports);
    const peakPrev = BigInt(live.peakSolRemainderLamports ?? baseline);
    const peak = outFull > peakPrev ? outFull : peakPrev;
    if (idx >= 0 && peak !== peakPrev) {
      state.paper.positions[idx].peakSolRemainderLamports = peak.toString();
      writeState(state);
    }

    let reason = resolveJupiterRemainderExit(outFull, baseline);
    if (!reason) reason = resolveJupiterTrailingRemainder(outFull, peak, baseline);
    if (!reason) return;

    const quoteRem = await jupiterQuoteV6(pos.mint, SOL_MINT, bal, slippageBps);
    if (!quoteRem.ok) return;
    const outRem = BigInt(quoteRem.data.outAmount);
    finalizePaperFullExit(pos, reason, outRem);
    return;
  }

  const reason = resolveJupiterQuoteExit(outFull, entry);
  if (!reason) return;
  finalizePaperFullExit(pos, reason, outFull);
}

const watch = watchCfg;
const minIntervalMs = watch.minIntervalMs ?? 220;
const maxQueue = watch.maxQueue ?? 500;
const maxSeen = watch.maxSeenSignatures ?? 8000;
const logQuiet = watch.logQuietReasons === true;

let keypair = null;
if (mode === "execute") {
  const secret = process.env.TRADING_WALLET_SECRET?.trim();
  if (!secret) {
    console.error("whale-follow: execution.mode is execute but TRADING_WALLET_SECRET is empty.");
    process.exit(1);
  }
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(secret));
  } catch (e) {
    console.error("whale-follow: bad TRADING_WALLET_SECRET (expect base58 64-byte secret):", e?.message ?? e);
    process.exit(1);
  }
  console.log("whale-follow: EXECUTE mode — wallet", keypair.publicKey.toBase58());
} else if (isPaper) {
  console.log(
    "whale-follow: PAPER mode — simulasi (quote Jupiter + saldo virtual); tidak kirim tx | saldo awal ~",
    paperInitialBalanceSol,
    "SOL"
  );
} else {
  console.log(
    "whale-follow: LOG_ONLY — no swaps; set execution.mode to \"paper\" (simulasi) atau \"execute\" + TRADING_WALLET_SECRET."
  );
}

let state;
try {
  state = readJson(paths.state);
} catch {
  state = { updatedAt: null, daemon: {}, today: {}, openPositions: [], lastError: null };
}
if (!Array.isArray(state.openPositions)) state.openPositions = [];

function ensurePaperState() {
  if (!state.paper) {
    state.paper = {
      virtualSolLamports: String(BigInt(Math.floor(paperInitialBalanceSol * 1e9))),
      positions: [],
      wins: 0,
      losses: 0,
      breakeven: 0,
      totalRealizedPnlLamports: "0",
    };
  }
  if (!Array.isArray(state.paper.positions)) state.paper.positions = [];
  if (state.paper.virtualSolLamports == null) {
    state.paper.virtualSolLamports = String(BigInt(Math.floor(paperInitialBalanceSol * 1e9)));
  }
  for (const k of ["wins", "losses", "breakeven"]) {
    if (state.paper[k] == null) state.paper[k] = 0;
  }
  if (state.paper.totalRealizedPnlLamports == null) state.paper.totalRealizedPnlLamports = "0";
}

if (isPaper) ensurePaperState();

const seen = new Set();
const queue = [];
let workerRunning = false;

/**
 * Satu antrian untuk semua baca/tulis `state` (worker beli vs poll jual paper/execute).
 * Tanpa ini, await (quote Jupiter, RPC) bisa menyilang dan menimpa virtualSol / positions.
 */
let stateMutexChain = Promise.resolve();
function runStateExclusive(fn) {
  const next = stateMutexChain.then(() => fn());
  stateMutexChain = next.then(
    () => {},
    () => {}
  );
  return next;
}

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

async function tryBuyCopy(whaleMeta) {
  if (!keypair) return { ok: false, reason: "no_keypair" };

  const mint = whaleMeta.mint;
  if (state.openPositions.some((p) => p.mint === mint)) {
    return { ok: false, reason: "already_hold_mint" };
  }
  if (state.openPositions.length >= maxOpenPositions) {
    return { ok: false, reason: "max_positions" };
  }

  let entryMcapSol = null;
  const mcapSnap = await getPumpBondingCurveMcapSol(connection, whaleMeta.bondingCurve, {
    mcapSolScale,
  });
  if (mcapSnap.ok && !mcapSnap.complete && mcapSnap.mcapSol != null) {
    entryMcapSol = mcapSnap.mcapSol;
    if (minEntryMcapSol != null && entryMcapSol < minEntryMcapSol) {
      return { ok: false, reason: "entry_mcap_too_low", mcapSol: entryMcapSol, min: minEntryMcapSol };
    }
    if (maxEntryMcapSol != null && entryMcapSol > maxEntryMcapSol) {
      return { ok: false, reason: "entry_mcap_too_high", mcapSol: entryMcapSol, max: maxEntryMcapSol };
    }
  }

  const balance = await connection.getBalance(keypair.publicKey, "confirmed");
  const maxLamports = BigInt(Math.floor(maxBuySol * 1e9));
  let spend = maxLamports < BigInt(balance) - lamportsReserve ? maxLamports : BigInt(balance) - lamportsReserve;
  if (spend <= 0n) {
    return { ok: false, reason: "insufficient_sol", balance, reserve: lamportsReserve.toString() };
  }

  const quote = await jupiterQuoteV6(SOL_MINT, mint, spend, slippageBps);
  if (!quote.ok) {
    return { ok: false, reason: "quote_failed", detail: quote };
  }

  const swap = await jupiterSwapV6(connection, keypair, quote.data);
  if (!swap.ok) {
    return { ok: false, reason: "swap_failed", detail: swap };
  }

  const inAmt = quote.data.inAmount != null ? String(quote.data.inAmount) : spend.toString();
  const spendLamports = BigInt(inAmt);
  const tokenBal = await getWalletTokenRawAmount(connection, keypair.publicKey.toBase58(), mint);
  const entryPxUi = tokenBal > 0n ? solPerTokenUi(spendLamports, tokenBal) : null;
  state.openPositions.push({
    mint,
    bondingCurve: whaleMeta.bondingCurve,
    entrySolLamports: inAmt,
    paperTokenRaw: tokenBal.toString(),
    entryMcapSol: entryMcapSol ?? undefined,
    peakMcapSol: entryMcapSol ?? undefined,
    entryAvgSolPerTokenUi: entryPxUi ?? undefined,
    exitMode,
    modalRecovered: false,
    partialTpCount: 0,
    remainderBaselineSolLamports: undefined,
    peakSolRemainderLamports: undefined,
    buySignature: swap.signature,
    whaleCopyOfSignature: whaleMeta.signature,
    openedAt: new Date().toISOString(),
  });
  state.today.executedBuys = (state.today.executedBuys ?? 0) + 1;
  state.updatedAt = new Date().toISOString();
  writeState(state);

  console.log(
    "[follow] BOUGHT",
    mint.slice(0, 8) + "…",
    "spend~",
    Number(inAmt) / 1e9,
    "SOL",
    "| harga_entry ~",
    formatSolPerTokenLabel(entryPxUi),
    "SOL/token",
    entryMcapSol != null ? "| mcap~ " + entryMcapSol.toFixed(2) + " SOL" : "",
    "| tx",
    swap.signature.slice(0, 16) + "…"
  );

  return { ok: true, signature: swap.signature, entrySolLamports: inAmt };
}

async function tryExitPosition(pos) {
  if (!keypair) return;
  const bal = await getWalletTokenRawAmount(connection, keypair.publicKey.toBase58(), pos.mint);
  if (bal === 0n) {
    state.openPositions = state.openPositions.filter((p) => p.mint !== pos.mint);
    writeState(state);
    clearExitQuoteWarnThrottle(pos.mint);
    console.log("[follow] position removed (zero balance)", pos.mint.slice(0, 8) + "…");
    return;
  }

  const quoteFull = await jupiterQuoteV6(pos.mint, SOL_MINT, bal, slippageBps);
  if (!quoteFull.ok) {
    logExitQuoteFailed("follow", pos.mint, quoteFull);
    return;
  }

  const outFull = BigInt(quoteFull.data.outAmount);
  const entry = BigInt(pos.entrySolLamports);
  const posExitMode = pos.exitMode ?? exitMode;

  const staleReasonExec = await maybeExitStaleChart(pos, outFull, "execute");
  if (staleReasonExec) {
    await finalizeFullExit(pos, quoteFull.data, staleReasonExec, entry, outFull, bal);
    return;
  }

  if (posExitMode === "mcap_sol" && pos.entryMcapSol != null) {
    let reason = null;
    const snap = await getPumpBondingCurveMcapSol(connection, pos.bondingCurve, { mcapSolScale });
    if (snap.ok && snap.complete) {
      reason = resolveJupiterQuoteExit(outFull, entry);
    } else if (snap.ok && snap.mcapSol != null) {
      const mcap = snap.mcapSol;
      const idx = state.openPositions.findIndex((p) => p.mint === pos.mint);
      const live = idx >= 0 ? state.openPositions[idx] : pos;
      const entryM = live.entryMcapSol;
      const peak = Math.max(live.peakMcapSol ?? entryM, mcap);
      if (idx >= 0 && peak !== live.peakMcapSol) {
        state.openPositions[idx].peakMcapSol = peak;
        writeState(state);
      }

      const tpM = resolveTpMcapSol(live);
      const slM = resolveSlMcapSol(live);
      if (tpM != null && mcap >= tpM) reason = "take_profit_mcap";
      else if (slM != null && mcap <= slM) reason = "stop_loss_mcap";
      else if (
        trailingStopPctFromPeak != null &&
        entryM != null &&
        peak > entryM * 1.01 &&
        mcap >= entryM &&
        mcap <= peak * (1 - trailingStopPctFromPeak / 100)
      ) {
        reason = "trailing_stop_mcap";
      }

      if (reason == null && entryM != null) {
        const runPct = ((mcap - entryM) / entryM) * 100;
        if (wf.logMcapEachPoll === true) {
          console.log(
            "[follow] mcap",
            pos.mint.slice(0, 6) + "…",
            "now",
            mcap.toFixed(1),
            "SOL | entry",
            entryM.toFixed(1),
            "| peak",
            peak.toFixed(1),
            "| run ~",
            runPct.toFixed(0) + "%"
          );
        }
      }
    } else {
      reason = resolveJupiterQuoteExit(outFull, entry);
    }
    if (!reason) return;
    await finalizeFullExit(pos, quoteFull.data, reason, entry, outFull, bal);
    return;
  }

  if (posExitMode === "jupiter_quote" && recoverModalFirst) {
    const idx = state.openPositions.findIndex((p) => p.mint === pos.mint);
    const live = idx >= 0 ? state.openPositions[idx] : pos;

    if (outFull <= (entry * BigInt(100 - stopLossPct)) / 100n) {
      await finalizeFullExit(pos, quoteFull.data, "stop_loss", entry, outFull, bal);
      return;
    }

    const alreadyPulledModal =
      live.modalRecovered === true ||
      (live.remainderBaselineSolLamports != null &&
        String(live.remainderBaselineSolLamports).length > 0);
    const canPartialRecover =
      !alreadyPulledModal && shouldTriggerRecoverModalPartial(outFull, entry);

    if (canPartialRecover && outFull > 0n) {
      const targetSol = recoverModalTargetSolLamports(entry);
      if (targetSol >= outFull) {
        await finalizeFullExit(pos, quoteFull.data, "take_profit_full", entry, outFull, bal);
        return;
      }
      const partialBal = (bal * targetSol) / outFull;
      if (partialBal <= 0n) return;
      if (partialBal >= bal) {
        await finalizeFullExit(pos, quoteFull.data, "take_profit_full", entry, outFull, bal);
        return;
      }
      const qPart = await jupiterQuoteV6(pos.mint, SOL_MINT, partialBal, slippageBps);
      if (!qPart.ok) return;
      const solOutPart = BigInt(qPart.data.outAmount);
      const swapPart = await jupiterSwapV6(connection, keypair, qPart.data);
      if (!swapPart.ok) {
        console.error("[follow] partial swap failed", swapPart);
        return;
      }
      if (idx < 0) return;
      const newBal = await getWalletTokenRawAmount(connection, keypair.publicKey.toBase58(), pos.mint);
      const qRem = await jupiterQuoteV6(pos.mint, SOL_MINT, newBal, slippageBps);
      if (!qRem.ok) {
        state.openPositions[idx].modalRecovered = true;
        writeState(state);
        return;
      }
      const remOut = BigInt(qRem.data.outAmount);
      state.openPositions[idx].modalRecovered = true;
      state.openPositions[idx].partialTpCount = (Number(live.partialTpCount) || 0) + 1;
      state.openPositions[idx].paperTokenRaw = newBal.toString();
      state.openPositions[idx].remainderBaselineSolLamports = remOut.toString();
      state.openPositions[idx].peakSolRemainderLamports = remOut.toString();
      state.updatedAt = new Date().toISOString();
      writeState(state);
      const slicePx = solPerTokenUi(solOutPart, partialBal);
      console.log(
        "[follow] partial TP",
        state.openPositions[idx].partialTpCount,
        "— slice",
        recoverModalPctOfEntrySol + "% entry ~",
        Number(targetSol) / 1e9,
        "SOL | harga_slice ~",
        formatSolPerTokenLabel(slicePx),
        "SOL/token | sisa ~",
        Number(remOut) / 1e9,
        "SOL | tx",
        swapPart.signature.slice(0, 16) + "…"
      );
      return;
    }

    if (live.remainderBaselineSolLamports == null || String(live.remainderBaselineSolLamports).length === 0) {
      return;
    }

    let baseline = BigInt(live.remainderBaselineSolLamports);
    const peakPrev = BigInt(live.peakSolRemainderLamports ?? baseline);
    const peak = outFull > peakPrev ? outFull : peakPrev;
    if (idx >= 0 && peak !== peakPrev) {
      state.openPositions[idx].peakSolRemainderLamports = peak.toString();
      writeState(state);
    }

    let reason = resolveJupiterRemainderExit(outFull, baseline);
    if (!reason) reason = resolveJupiterTrailingRemainder(outFull, peak, baseline);
    if (!reason) return;

    const quoteRem = await jupiterQuoteV6(pos.mint, SOL_MINT, bal, slippageBps);
    if (!quoteRem.ok) return;
    const outRem = BigInt(quoteRem.data.outAmount);
    await finalizeFullExit(pos, quoteRem.data, reason, entry, outRem, bal);
    return;
  }

  const reason = resolveJupiterQuoteExit(outFull, entry);
  if (!reason) return;
  await finalizeFullExit(pos, quoteFull.data, reason, entry, outFull, bal);
}

async function pollPositions() {
  await runStateExclusive(async () => {
    if (mode === "execute" && keypair) {
      const copy = [...state.openPositions];
      for (const pos of copy) {
        await tryExitPosition(pos);
      }
    } else if (isPaper) {
      ensurePaperState();
      const copy = [...state.paper.positions];
      for (const pos of copy) {
        await tryPaperExitPosition(pos);
      }
    }
  });
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length > 0) {
      const signature = queue.shift();

      await runStateExclusive(async () => {
        try {
          const result = await buildPipelineForSignature(connection, policy, signature, {
            pipelineKind: "whale_follow_stream",
            source: watchTransport === "poll" ? "pollSignatures" : "logsSubscribe",
          });

          if ("quiet" in result && result.quiet) {
            if (logQuiet) {
              console.log(
                "[follow quiet]",
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
              status: "follow_ok",
              lastHeartbeatAt: now,
              paused: fs.existsSync(paths.pauseFile(pauseName)),
              rpcHost: rpcDisplayHost(policy),
            };
            state.lastError = null;

            const pipeline = {
              ...result.pipeline,
              whaleFollow: { maxOpenPositions, mode },
            };
            appendSignal(pipeline);
            writeState(state);

            const w = result.pipeline.whale;
            const p = result.pipeline;
            const wiLog = p.walletIntelligence?.logText;
            if (wiLog) {
              console.log(wiLog);
            }
            if (p.walletIntelligence?.skippedByRatio) {
              console.log(
                "[follow] skip — wallet_intelligence:",
                p.walletIntelligence.skipReason ?? "ratio_threshold"
              );
            }
            if (p.action === "would_buy") {
              const rf = p.redFlags ?? [];
              console.log("[follow] would_buy — lolos red flag");
              console.log("  CA (mint)     :", w.mint);
              console.log("  Whale wallet  :", w.user);
              console.log("  Tx signature  :", w.signature);
              console.log("  ~SOL (keluar) :", w.solEstimateFromIx, "| sumber:", w.solEstimateSource ?? "?");
              if (w.maxSolCostSol != null && w.maxSolCostSol > w.solEstimateFromIx * 1.01) {
                console.log(
                  "  (max_sol ix)  :",
                  w.maxSolCostSol,
                  "SOL — plafon slippage di instruksi, bukan pemakaian aktual"
                );
              }
              console.log(
                "  Red flags     :",
                rf.length ? rf.join(", ") : "none",
                `(skip jika ≥ ${policy.safety?.skipIfRedFlagsGte ?? 2})`
              );
            } else {
              const rf = p.redFlags ?? [];
              console.log(
                "[follow]",
                p.action,
                w.signature.slice(0, 16) + "…",
                "~",
                w.solEstimateFromIx,
                "SOL | red flags:",
                rf.length,
                rf.length ? "(" + rf.join(", ") + ")" : ""
              );
            }

            if (result.pipeline.action === "would_buy" && mode === "execute" && keypair) {
              const paused = fs.existsSync(paths.pauseFile(pauseName));
              if (paused) {
                console.log("[follow] PAUSE file present — skip buy");
              } else {
                const buy = await tryBuyCopy(w);
                if (!buy.ok) {
                  console.log("[follow] skip buy:", buy.reason, buy.detail ?? "");
                }
              }
            } else if (result.pipeline.action === "would_buy" && isPaper) {
              const paused = fs.existsSync(paths.pauseFile(pauseName));
              if (paused) {
                console.log("[follow] PAUSE file present — skip paper buy");
              } else {
                const buy = await tryPaperBuyCopy(w);
                if (!buy.ok) {
                  console.log("[paper] skip buy:", buy.reason, buy.detail ?? "");
                }
              }
            } else if (result.pipeline.action === "would_buy" && mode === "log_only") {
              console.log(
                "  mode          : log_only (tidak swap — pakai execution.mode=\"paper\" untuk simulasi + statistik)"
              );
            }
          }
        } catch (e) {
          const msg = e?.message ?? String(e);
          const cause = e?.cause;
          const detail =
            cause != null ? `${msg} | cause: ${cause?.message ?? String(cause)}` : msg;
          state.lastError = { at: new Date().toISOString(), message: detail };
          state.today.errors = (state.today.errors ?? 0) + 1;
          writeState(state);
          console.error("[follow] error:", detail);
        }
      });

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
  console.log("whale-follow: transport websocket | logsSubscribe", wsSubId);
} else {
  stopSigPoll = startPumpSignaturePoll({
    connection,
    pumpProgramKey: pumpKey,
    rememberSignature,
    enqueue,
    pollIntervalMs: sigPollMs,
    limit: sigPollLimit,
  });
  console.log("whale-follow: transport poll | every", sigPollMs, "ms | limit", sigPollLimit);
}

setInterval(() => {
  void pollPositions();
}, pollIntervalMs);

console.log("whale-follow: pump ingest OK");
if (isPaper) {
  ensurePaperState();
  const closed =
    (state.paper.wins ?? 0) + (state.paper.losses ?? 0) + (state.paper.breakeven ?? 0);
  const wr = closed > 0 ? ((state.paper.wins ?? 0) / closed) * 100 : 0;
  console.log(
    "  paper: virtual",
    Number(BigInt(state.paper.virtualSolLamports)) / 1e9,
    "SOL | closed",
    closed,
    "| win%",
    wr.toFixed(1),
    "| ΣPnL",
    Number(BigInt(state.paper.totalRealizedPnlLamports ?? 0)) / 1e9,
    "SOL | open",
    state.paper.positions.length
  );
}
console.log(
  "  exit:",
  exitMode,
  exitMode === "mcap_sol"
    ? "| mcap TP×" +
        (takeProfitMcapMultiple ?? defaultTakeProfitMcapMultiple) +
        " SL×" +
        (stopLossMcapFractionOfEntry ?? defaultStopLossMcapFractionOfEntry) +
        (trailingStopPctFromPeak != null ? " trail−" + trailingStopPctFromPeak + "%peak" : "")
    : "| jupiter SL " +
        stopLossPct +
        "% | 1×partial vs entry +" +
        recoverModalMinGainPct +
        "% → slice " +
        recoverModalPctOfEntrySol +
        "% entry | remainder " +
        (remainderTakeProfitPctCfg === null ? "no TP%" : "TP " + remainderTakeProfitPctCfg + "%") +
        " + trail−" +
        (trailingStopPctFromPeak ?? "off") +
        "%peak"
);
console.log("  throttle:", minIntervalMs, "ms | max positions:", maxOpenPositions);
console.log("  poll:", pollIntervalMs, "ms | host:", rpcDisplayHost(policy));
console.log("  Ctrl+C to stop");

void pollPositions();

async function shutdown() {
  try {
    if (stopSigPoll) stopSigPoll();
    if (wsSubId != null) await connection.removeOnLogsListener(wsSubId);
  } catch (e) {
    console.error("unsubscribe:", e?.message ?? e);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
