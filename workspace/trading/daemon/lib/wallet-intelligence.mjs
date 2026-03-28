/**
 * Wallet Intelligence Engine — klasifikasi perilaku wallet pada pump.fun (heuristik).
 *
 * Dipanggil dari `buildPipelineForSignature` untuk skor tambahan dan filter masuk.
 * Tidak mengganti watcher, paper engine, atau Jupiter executor.
 *
 * Heuristik:
 * - SNIPER: beli sangat dekat launch (slot/waktu) + banyak mint pump berbeda di riwayat singkat,
 *   atau peringkat pembeli awal sangat depan.
 * - SMART_MONEY: perkiraan win rate & hold time dari pola buy→sell pada mint target.
 * - DUMPER: beli awal lalu jual cepat dengan profit rendah.
 * - DEVELOPER: relasi ke creator (daftar pubkey prefix di config).
 * - NORMAL: fallback.
 */

import { PublicKey } from "@solana/web3.js";
import { ownerNetSolDeltaLamports, ownerTokenDeltaForMintRaw } from "./pump-analyze.mjs";
import { fetchEarlyPumpBuyersForMint } from "./wallet-insider.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Cooldown global setelah 429 / CU limit — skip analisis berat sementara. */
let walletIntelCooldownUntil = 0;

function isRateLimitErr(e) {
  const m = String(e?.message ?? e ?? "").toLowerCase();
  return (
    m.includes("429") ||
    m.includes("too many requests") ||
    m.includes("compute units") ||
    m.includes("rate limit")
  );
}

function noteRateLimitMs(cooldownMs) {
  const ms = Math.max(5000, cooldownMs ?? 60_000);
  walletIntelCooldownUntil = Math.max(walletIntelCooldownUntil, Date.now() + ms);
}

/** @typedef {'SMART_MONEY'|'SNIPER'|'DEVELOPER'|'DUMPER'|'NORMAL'} WalletType */

export const WALLET_TYPES = {
  SMART_MONEY: "SMART_MONEY",
  SNIPER: "SNIPER",
  DEVELOPER: "DEVELOPER",
  DUMPER: "DUMPER",
  NORMAL: "NORMAL",
};

function walletMatchesPrefixList(wallet, prefixes) {
  if (!wallet || !Array.isArray(prefixes)) return false;
  return prefixes.some((p) => typeof p === "string" && p.length > 0 && wallet.startsWith(p));
}

/**
 * Klasifikasi dari fitur + opsi peringkat pembeli awal (slot).
 *
 * @param {string} walletAddress
 * @param {{
 *   numberOfTokensBoughtRecently?: number,
 *   averageHoldTimeSec?: number | null,
 *   profitRate?: number | null,
 *   buyTimeRelativeToLaunchSec?: number | null,
 *   sellSpeedAfterBuySec?: number | null,
 *   creatorRelation?: boolean,
 *   earlyBuyerRank?: number | null,
 *   slotDeltaFromLaunch?: number | null,
 * }} walletHistory
 * @param {{ rules?: object, creatorWalletPrefixes?: string[] }} [opts]
 * @returns {WalletType}
 */
export function classifyWallet(walletAddress, walletHistory, opts = {}) {
  const h = walletHistory ?? {};
  const r = opts.rules ?? {};
  const creators = opts.creatorWalletPrefixes ?? [];

  if (h.creatorRelation === true || walletMatchesPrefixList(walletAddress, creators)) {
    return WALLET_TYPES.DEVELOPER;
  }

  /* Hanya pembeli paling depan + slot sangat dekat launch = sniper posisional (hindari sniper_ratio ~1). */
  const maxSlotDelta = r.sniperMaxSlotDelta ?? 6;
  const maxEarlyRank = r.sniperEarlyRankMax ?? 4;
  if (
    h.earlyBuyerRank != null &&
    h.earlyBuyerRank <= maxEarlyRank &&
    h.slotDeltaFromLaunch != null &&
    h.slotDeltaFromLaunch <= maxSlotDelta
  ) {
    return WALLET_TYPES.SNIPER;
  }

  const tokensRecent = h.numberOfTokensBoughtRecently ?? 0;
  const buyRel = h.buyTimeRelativeToLaunchSec;
  const sellSpeed = h.sellSpeedAfterBuySec;
  const profit = h.profitRate;
  const hold = h.averageHoldTimeSec;

  const sniperLaunchSec = r.sniperLaunchWithinSec ?? 120;
  const sniperMinTokens = r.sniperMinRecentTokens ?? 4;

  if (buyRel != null && buyRel <= sniperLaunchSec && tokensRecent >= sniperMinTokens) {
    return WALLET_TYPES.SNIPER;
  }

  const dumperBuyEarlySec = r.dumperBuyWithinSec ?? 300;
  const dumperSellFastSec = r.dumperSellWithinSec ?? 120;
  const dumperMaxProfit = r.dumperMaxProfitRate ?? 0.4;

  if (
    buyRel != null &&
    buyRel <= dumperBuyEarlySec &&
    sellSpeed != null &&
    sellSpeed <= dumperSellFastSec &&
    (profit == null || profit <= dumperMaxProfit)
  ) {
    return WALLET_TYPES.DUMPER;
  }

  const smMinProfit = r.smartMinProfitRate ?? 0.55;
  const smMinHold = r.smartMinHoldSec ?? 300;
  const smMinSellSpeed = r.smartMinSellAfterBuySec ?? 180;

  if (
    profit != null &&
    profit >= smMinProfit &&
    hold != null &&
    hold >= smMinHold &&
    sellSpeed != null &&
    sellSpeed >= smMinSellSpeed
  ) {
    return WALLET_TYPES.SMART_MONEY;
  }

  return WALLET_TYPES.NORMAL;
}

/**
 * Kumpulkan mint yang punya perubahan token untuk owner di tx ini.
 */
function mintsTouchedByOwner(parsed, ownerPkStr) {
  const pre = parsed?.meta?.preTokenBalances ?? [];
  const post = parsed?.meta?.postTokenBalances ?? [];
  const out = new Set();
  for (const tb of pre) {
    if (tb?.owner === ownerPkStr && tb?.mint) out.add(tb.mint);
  }
  for (const tb of post) {
    if (tb?.owner === ownerPkStr && tb?.mint) out.add(tb.mint);
  }
  return [...out];
}

/**
 * Estimasi riwayat singkat wallet untuk fitur klasifikasi.
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} wallet
 * @param {string} mint
 * @param {{
 *   launchBlockTimeSec?: number | null,
 *   limitSignatures?: number,
 *   windowMinutes?: number,
 *   pauseMsBetweenParsedTxs?: number,
 *   rateLimitCooldownMs?: number,
 *   pauseMsOnRateLimit?: number,
 * }} ctx
 */
export async function buildWalletHistoryFeatures(connection, wallet, mint, ctx = {}) {
  const limit = ctx.limitSignatures ?? 25;
  const windowMinutes = ctx.windowMinutes ?? 120;
  const windowMs = windowMinutes * 60 * 1000;
  const nowMs = Date.now();
  const pauseTx = ctx.pauseMsBetweenParsedTxs ?? 0;
  const rlCooldown = ctx.rateLimitCooldownMs ?? 60_000;
  const pauseOn429 = ctx.pauseMsOnRateLimit ?? 2500;

  let walletPk;
  try {
    walletPk = new PublicKey(wallet);
  } catch {
    return emptyHistory();
  }

  let sigs;
  try {
    sigs = await connection.getSignaturesForAddress(walletPk, { limit });
  } catch (e) {
    if (isRateLimitErr(e)) noteRateLimitMs(rlCooldown);
    return emptyHistory();
  }

  /** @type {{ mint: string, side: 'buy'|'sell', tsMs: number, tokDelta: bigint, solDelta: bigint }[]} */
  const events = [];

  for (const s of sigs) {
    if (s.err || !s.signature) continue;
    let parsed;
    try {
      parsed = await connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch (e) {
      if (isRateLimitErr(e)) {
        noteRateLimitMs(rlCooldown);
        await sleep(pauseOn429);
      }
      if (pauseTx) await sleep(pauseTx);
      continue;
    }
    if (pauseTx) await sleep(pauseTx);
    if (!parsed || parsed.meta?.err) continue;

    const tsMs =
      typeof parsed.blockTime === "number" && parsed.blockTime > 0
        ? parsed.blockTime * 1000
        : nowMs;
    if (nowMs - tsMs > windowMs) continue;

    const mints = mintsTouchedByOwner(parsed, wallet);
    for (const m of mints) {
      const tokDelta = ownerTokenDeltaForMintRaw(parsed, wallet, m);
      if (tokDelta === 0n) continue;
      const solDelta = ownerNetSolDeltaLamports(parsed, wallet);
      if (solDelta == null) continue;

      let side = null;
      if (tokDelta > 0n && solDelta < 0n) side = "buy";
      else if (tokDelta < 0n && solDelta > 0n) side = "sell";
      if (!side) continue;

      events.push({ mint: m, side, tsMs, tokDelta, solDelta });
    }
  }

  events.sort((a, b) => a.tsMs - b.tsMs);

  const buyMints = new Set(events.filter((e) => e.side === "buy").map((e) => e.mint));
  const numberOfTokensBoughtRecently = buyMints.size;

  const targetEvents = events.filter((e) => e.mint === mint);
  const buys = targetEvents.filter((e) => e.side === "buy");
  const sells = targetEvents.filter((e) => e.side === "sell");

  let buyTimeRelativeToLaunchSec = null;
  const launchT = ctx.launchBlockTimeSec;
  if (launchT != null && buys.length) {
    const firstBuySec = buys[0].tsMs / 1000;
    buyTimeRelativeToLaunchSec = Math.max(0, firstBuySec - launchT);
  }

  let sellSpeedAfterBuySec = null;
  const holdSamples = [];
  let buySol = 0n;
  let sellSol = 0n;

  for (const b of buys) {
    buySol += -b.solDelta > 0n ? -b.solDelta : 0n;
    const nextSell = sells.find((se) => se.tsMs >= b.tsMs);
    if (nextSell) {
      const dtSec = (nextSell.tsMs - b.tsMs) / 1000;
      sellSpeedAfterBuySec =
        sellSpeedAfterBuySec == null ? dtSec : Math.min(sellSpeedAfterBuySec, dtSec);
      holdSamples.push(dtSec);
    }
  }
  for (const se of sells) {
    sellSol += se.solDelta > 0n ? se.solDelta : 0n;
  }

  const averageHoldTimeSec =
    holdSamples.length > 0
      ? holdSamples.reduce((a, b) => a + b, 0) / holdSamples.length
      : null;

  let profitRate = null;
  const buySolN = Number(buySol) / 1e9;
  const sellSolN = Number(sellSol) / 1e9;
  if (buySolN > 1e-9 && sellSolN > 0) {
    profitRate = Math.min(1, Math.max(0, sellSolN / buySolN));
  }

  return {
    numberOfTokensBoughtRecently,
    averageHoldTimeSec,
    profitRate,
    buyTimeRelativeToLaunchSec,
    sellSpeedAfterBuySec,
    creatorRelation: false,
  };
}

function emptyHistory() {
  return {
    numberOfTokensBoughtRecently: 0,
    averageHoldTimeSec: null,
    profitRate: null,
    buyTimeRelativeToLaunchSec: null,
    sellSpeedAfterBuySec: null,
    creatorRelation: false,
  };
}

/**
 * Analisis N pembeli awal + klasifikasi (RPC bounded).
 */
export async function analyzeTokenWalletMix(connection, pumpProgramId, mint, bondingCurve, cfg) {
  if (Date.now() < walletIntelCooldownUntil) {
    return {
      ok: false,
      smartWallets: 0,
      snipers: 0,
      dumpers: 0,
      developers: 0,
      normals: 0,
      smartRatio: 0,
      sniperRatio: 0,
      dumperRatio: 0,
      details: {
        error: "wallet_intel_rpc_cooldown",
        untilMs: walletIntelCooldownUntil,
      },
    };
  }

  const firstN = Math.max(5, cfg.firstBuyers ?? 20);
  const maxClassify = Math.min(firstN, Math.max(1, cfg.maxWalletsToClassify ?? 8));
  /* Default pacing mengurangi 429 / CU burst pada provider RPC (mis. Alchemy). Set ke 0 untuk menonaktifkan. */
  const pauseAfterEarly = cfg.pauseMsAfterEarlyBuyers ?? 120;
  const pauseBetweenWallets = cfg.pauseMsBetweenWallets ?? 200;
  const pauseDecode = cfg.pauseMsBetweenDecodes ?? 45;

  let early;
  try {
    early = await fetchEarlyPumpBuyersForMint(
      connection,
      pumpProgramId,
      bondingCurve,
      mint,
      {
        maxSignatures: cfg.maxSignatures ?? 1500,
        maxDecode: cfg.maxDecode ?? 200,
        targetUniqueBuyers: firstN,
        pauseMsBetweenDecodes: pauseDecode,
        onRpcRateLimit: () => noteRateLimitMs(cfg.rateLimitCooldownMs ?? 90_000),
      }
    );
  } catch (e) {
    if (isRateLimitErr(e)) noteRateLimitMs(cfg.rateLimitCooldownMs);
    return {
      ok: false,
      smartWallets: 0,
      snipers: 0,
      dumpers: 0,
      developers: 0,
      normals: 0,
      smartRatio: 0,
      sniperRatio: 0,
      dumperRatio: 0,
      details: { error: String(e?.message ?? e) },
    };
  }

  if (pauseAfterEarly) await sleep(pauseAfterEarly);

  if (!early.ok || !early.buyers?.length) {
    return {
      ok: false,
      smartWallets: 0,
      snipers: 0,
      dumpers: 0,
      developers: 0,
      normals: 0,
      smartRatio: 0,
      sniperRatio: 0,
      dumperRatio: 0,
      details: { error: early.error ?? "no_buyers" },
    };
  }

  const buyers = early.buyers;
  const launchBt =
    typeof buyers[0]?.blockTime === "number" && buyers[0].blockTime > 0
      ? buyers[0].blockTime
      : null;
  const launchSlot = buyers[0]?.slot ?? 0;

  let smart = 0;
  let sniper = 0;
  let dumper = 0;
  let dev = 0;
  let normal = 0;

  const classified = [];
  const slice = buyers.slice(0, maxClassify);
  let idx = 0;
  for (const row of slice) {
    if (idx > 0 && pauseBetweenWallets) await sleep(pauseBetweenWallets);
    const earlyBuyerRank = idx;
    idx += 1;
    const slotDeltaFromLaunch =
      row.slot != null && launchSlot != null ? Math.max(0, row.slot - launchSlot) : null;

    const hist = await buildWalletHistoryFeatures(connection, row.user, mint, {
      launchBlockTimeSec: launchBt,
      limitSignatures: cfg.perWalletSignatures ?? 22,
      windowMinutes: cfg.historyWindowMinutes ?? 120,
      pauseMsBetweenParsedTxs: cfg.pauseMsBetweenHistoryTxs ?? 40,
      rateLimitCooldownMs: cfg.rateLimitCooldownMs,
      pauseMsOnRateLimit: cfg.pauseMsOnRateLimit ?? 2500,
    });

    const merged = {
      ...hist,
      earlyBuyerRank,
      slotDeltaFromLaunch,
    };

    const t = classifyWallet(row.user, merged, {
      rules: cfg.rules,
      creatorWalletPrefixes: cfg.creatorWalletPrefixes ?? [],
    });
    classified.push({ wallet: row.user, type: t });
    if (t === WALLET_TYPES.SMART_MONEY) smart += 1;
    else if (t === WALLET_TYPES.SNIPER) sniper += 1;
    else if (t === WALLET_TYPES.DUMPER) dumper += 1;
    else if (t === WALLET_TYPES.DEVELOPER) dev += 1;
    else normal += 1;
  }

  const denom = slice.length || 1;
  return {
    ok: true,
    smartWallets: smart,
    snipers: sniper,
    dumpers: dumper,
    developers: dev,
    normals: normal,
    smartRatio: smart / denom,
    sniperRatio: sniper / denom,
    dumperRatio: dumper / denom,
    details: {
      earlyBuyersSampled: slice.length,
      launchBlockTime: launchBt,
      launchSlot,
      classified,
      earlyStats: early.stats,
    },
  };
}

/**
 * entry_score = signal_score + wallet_score (wallet_score dari rasio).
 */
export function deriveEntryAdjustment(signalScore, mix, cfg) {
  let walletScore = 0;

  if (!mix?.ok) {
    return {
      walletScore: 0,
      entryScore: signalScore,
      positionSizeMultiplier: 1,
      skip: false,
    };
  }

  const maxDr = cfg.maxDumperRatio ?? 0.4;
  const minSm = cfg.minSmartMoneyRatio ?? 0.2;
  const sniperHi = cfg.sniperHighRatio ?? 0.5;

  if (mix.dumperRatio > maxDr) {
    return {
      walletScore: -0.5,
      entryScore: signalScore - 0.5,
      positionSizeMultiplier: 0,
      skip: true,
      reason: "dumper_ratio",
    };
  }

  if (mix.smartRatio >= minSm) {
    walletScore += 0.25;
  }

  let positionSizeMultiplier = 1;
  if (cfg.sniperPenalty && mix.sniperRatio >= sniperHi) {
    walletScore -= 0.15;
    positionSizeMultiplier = cfg.sniperSizeMultiplier ?? 0.5;
  }

  const entryScore = signalScore + walletScore;
  return {
    walletScore,
    entryScore,
    positionSizeMultiplier,
    skip: false,
  };
}

export function formatWalletIntelligenceLog(mint, mix, adj) {
  const lines = [
    "WALLET_INTELLIGENCE",
    `mint: ${mint}`,
    `smart_wallets: ${mix.smartWallets ?? 0}`,
    `snipers: ${mix.snipers ?? 0}`,
    `dumpers: ${mix.dumpers ?? 0}`,
    `developers: ${mix.developers ?? 0}`,
    `normals: ${mix.normals ?? 0}`,
    `smart_ratio: ${(mix.smartRatio ?? 0).toFixed(3)}`,
    `sniper_ratio: ${(mix.sniperRatio ?? 0).toFixed(3)}`,
    `dumper_ratio: ${(mix.dumperRatio ?? 0).toFixed(3)}`,
    `wallet_score: ${(adj.walletScore ?? 0).toFixed(3)}`,
    `entry_score: ${(adj.entryScore ?? 0).toFixed(3)}`,
    `position_size_multiplier: ${adj.positionSizeMultiplier ?? 1}`,
    adj.skip ? `SKIP: ${adj.reason ?? "yes"}` : "SKIP: no",
  ];
  return lines.join("\n");
}

/**
 * Orkestrasi untuk pipeline.
 */
export async function runWalletIntelligence(connection, policy, whaleMeta) {
  const cfg = policy.walletIntelligence ?? {};
  if (!cfg.enabled) {
    return {
      enabled: false,
      mix: { ok: false },
      adjustment: {
        walletScore: 0,
        entryScore: cfg.signalScore ?? 1,
        positionSizeMultiplier: 1,
        skip: false,
      },
      logText: "",
    };
  }

  const signalScore = cfg.signalScore ?? 1;

  const mix = await analyzeTokenWalletMix(
    connection,
    policy.chain.pumpProgramId,
    whaleMeta.mint,
    whaleMeta.bondingCurve,
    cfg
  );

  const adj = deriveEntryAdjustment(signalScore, mix, cfg);
  const logText = formatWalletIntelligenceLog(whaleMeta.mint, mix, adj);

  return {
    enabled: true,
    mix,
    adjustment: adj,
    logText,
  };
}

/** Alias snake_case sesuai spesifikasi. */
export const classify_wallet = classifyWallet;
