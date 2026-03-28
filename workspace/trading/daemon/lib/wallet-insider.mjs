/**
 * Playbook "wallet insider": alur kerja utama kamu = manual di DexScreener/Terminal + kurasi;
 * repo ini hanya menambah helper on-chain (early buyers, peer heuristik) dan DexScreener pair/market.
 *
 * Top Trader (~20 wallet) tidak tersedia lewat [DexScreener API publik](https://docs.dexscreener.com/api/reference)
 * — tetap lewat UI (atau API pihak ketiga jika nanti dipakai).
 */

import { PublicKey } from "@solana/web3.js";
import { findPumpBuyInTx } from "./pump-analyze.mjs";

function isLikelyRpcRateLimit(e) {
  const m = String(e?.message ?? e ?? "").toLowerCase();
  return (
    m.includes("429") ||
    m.includes("too many requests") ||
    m.includes("compute units") ||
    m.includes("rate limit")
  );
}

/**
 * Alur yang kamu mau — tiga langkah. `helperInRepo` = opsi otomasi di codebase ini.
 */
export const WALLET_INSIDER_METHODOLOGY = {
  version: 2,
  intent:
    "Temukan dompet berkualitas: awal di koin yang naik, kurasi dari Top Trader, lalu perluas rantai interaksi — bukan satu API aja.",
  steps: [
    {
      id: "early_before_pump",
      title: "Dompet masuk sangat awal",
      playbook:
        "Buka DexScreener atau Terminal. Scroll ke bawah di koin yang sedang naik. Cari dompet-dompet yang masuk sangat awal, sebelum harga naik drastis.",
      helperInRepo:
        "fetchEarlyPumpBuyersForMint() — perkiraan pembeli awal dari tx bonding curve (pump.fun), urut slot. Bukan pengganti baca chart manual.",
    },
    {
      id: "top_trader_curate",
      title: "Top Trader → simpan yang konsisten",
      playbook:
        "Cek fitur Top Trader: di setiap koin ada daftar ~20 trader terbaik. Biasanya sekitar 5 di antaranya pemain yang konsisten bagus dan layak dipantau jangka panjang — simpan itu ke watchlist kamu sendiri.",
      helperInRepo:
        "Tidak ada di dexscreener.mjs; lakukan di UI DexScreener/Terminal. (API publik DexScreener tidak expose leaderboard ini.)",
    },
    {
      id: "chain_wallets",
      title: "Rantai dompet (1 → banyak)",
      playbook:
        "Lacak dari satu dompet ke dompet lain: di blockchain, dompet bagus sering berinteraksi dengan dompet bagus lain. Ikuti rantainya — dari 1 dompet bisa menemukan ~10 dompet berkualitas untuk diteliti lebih lanjut.",
      helperInRepo:
        "expandWalletPeersFromRecentTxs() — kandidat pubkey yang sering muncul di tx bersama (heuristik; verifikasi manual).",
    },
  ],
};

/** Program sistem yang sering muncul — dikeluarkan dari daftar "peer" heuristik. */
const DEFAULT_IGNORE_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
]);

/**
 * Kumpulkan signature untuk alamat bonding curve (terbaru dulu), lalu batasi panjang.
 */
async function collectSignatureInfos(connection, bondingCurvePk, maxSignatures) {
  const out = [];
  let before = undefined;
  while (out.length < maxSignatures) {
    const batch = await connection.getSignaturesForAddress(bondingCurvePk, {
      limit: Math.min(1000, maxSignatures - out.length),
      before,
    });
    if (!batch.length) break;
    for (const s of batch) out.push(s);
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
  }
  return out;
}

/**
 * Pembeli pump.fun paling awal yang terlihat dari pemindaian bonding curve (urutan slot naik).
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} pumpProgramId
 * @param {string} bondingCurvePkStr
 * @param {string} mintPkStr
 * @param {{
 *   maxSignatures?: number,
 *   maxDecode?: number,
 *   targetUniqueBuyers?: number,
 *   ignorePrograms?: Set<string>,
 *   pauseMsBetweenDecodes?: number,
 *   onRpcRateLimit?: (e: unknown) => void,
 * }} [options]
 */
export async function fetchEarlyPumpBuyersForMint(
  connection,
  pumpProgramId,
  bondingCurvePkStr,
  mintPkStr,
  options = {}
) {
  const maxSignatures = options.maxSignatures ?? 2000;
  const maxDecode = options.maxDecode ?? 400;
  const targetUniqueBuyers = options.targetUniqueBuyers ?? 25;
  const pauseDecode =
    typeof options.pauseMsBetweenDecodes === "number" && options.pauseMsBetweenDecodes > 0
      ? options.pauseMsBetweenDecodes
      : 0;

  let curvePk;
  let mintOk;
  try {
    curvePk = new PublicKey(bondingCurvePkStr);
    mintOk = new PublicKey(mintPkStr);
  } catch {
    return { ok: false, error: "bad_pubkey", buyers: [], decoded: 0, sigInfos: 0 };
  }
  const mintStr = mintOk.toBase58();

  let sigInfos;
  try {
    sigInfos = await collectSignatureInfos(connection, curvePk, maxSignatures);
  } catch (e) {
    return {
      ok: false,
      error: `signatures:${e?.message ?? e}`,
      buyers: [],
      decoded: 0,
      sigInfos: 0,
    };
  }

  sigInfos.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  /** @type {{ user: string, signature: string, slot: number, blockTime: number | null, solEstimate: number }[]} */
  const buys = [];
  const seenSig = new Set();
  let decoded = 0;

  for (const info of sigInfos) {
    if (decoded >= maxDecode) break;
    const signature = info.signature;
    if (!signature || seenSig.has(signature)) continue;
    seenSig.add(signature);

    let parsed;
    try {
      parsed = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch (e) {
      if (typeof options.onRpcRateLimit === "function" && isLikelyRpcRateLimit(e)) {
        try {
          options.onRpcRateLimit(e);
        } catch {
          /* ignore */
        }
      }
      if (pauseDecode) await new Promise((r) => setTimeout(r, pauseDecode));
      continue;
    }
    decoded += 1;
    if (pauseDecode) await new Promise((r) => setTimeout(r, pauseDecode));

    if (!parsed || parsed.meta?.err) continue;
    const buy = findPumpBuyInTx(pumpProgramId, parsed);
    if (!buy || buy.mint !== mintStr) continue;

    const slot = parsed.slot ?? info.slot ?? 0;
    const blockTime = parsed.blockTime ?? info.blockTime ?? null;
    const solEstimate = Number(buy.solLamportsApprox) / 1e9;
    buys.push({
      user: buy.user,
      signature,
      slot,
      blockTime,
      solEstimate,
    });
  }

  /** Urutan unik pertama = paling awal (slot naik). */
  const uniqueOrder = [];
  const seenUser = new Set();
  for (const row of buys.sort((a, b) => a.slot - b.slot)) {
    if (seenUser.has(row.user)) continue;
    seenUser.add(row.user);
    uniqueOrder.push(row);
    if (uniqueOrder.length >= targetUniqueBuyers) break;
  }

  return {
    ok: true,
    mint: mintStr,
    bondingCurve: bondingCurvePkStr,
    buyers: uniqueOrder,
    stats: {
      signatureCandidates: sigInfos.length,
      decoded,
      pumpBuysMatched: buys.length,
      uniqueEarlyBuyers: uniqueOrder.length,
    },
  };
}

/**
 * Kumpulkan pubkey lain yang muncul di tx terkini bersama `walletPk` (heuristik graph).
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} walletPkStr
 * @param {{ limitSignatures?: number, ignorePrograms?: Set<string>, top?: number }} [options]
 */
export async function expandWalletPeersFromRecentTxs(connection, walletPkStr, options = {}) {
  const limitSignatures = options.limitSignatures ?? 30;
  const top = options.top ?? 15;
  const ignore = new Set(DEFAULT_IGNORE_PROGRAMS);
  if (options.ignorePrograms) {
    for (const x of options.ignorePrograms) ignore.add(x);
  }

  let walletPk;
  try {
    walletPk = new PublicKey(walletPkStr);
  } catch {
    return { ok: false, error: "bad_wallet", peers: [] };
  }

  let sigs;
  try {
    sigs = await connection.getSignaturesForAddress(walletPk, { limit: limitSignatures });
  } catch (e) {
    return { ok: false, error: `sigs:${e?.message ?? e}`, peers: [] };
  }

  const counts = new Map();
  let decoded = 0;

  for (const { signature, err } of sigs) {
    if (err || !signature) continue;
    let parsed;
    try {
      parsed = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    } catch {
      continue;
    }
    decoded += 1;
    if (!parsed?.transaction?.message) continue;

    const msg = parsed.transaction.message;
    const keys = msg.accountKeys ?? [];
    const setForTx = new Set();
    for (const k of keys) {
      const s =
        typeof k === "string"
          ? k
          : k?.pubkey != null
            ? String(k.pubkey)
            : typeof k?.toBase58 === "function"
              ? k.toBase58()
              : null;
      if (!s || s === walletPkStr) continue;
      if (ignore.has(s)) continue;
      setForTx.add(s);
    }
    for (const s of setForTx) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }

  const peers = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([pubkey, coOccurrences]) => ({ pubkey, coOccurrences }));

  return {
    ok: true,
    wallet: walletPkStr,
    peers,
    stats: { signatures: sigs.length, decoded },
  };
}
