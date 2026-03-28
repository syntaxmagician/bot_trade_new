/**
 * pump.fun instruction sniffing + red-flag evaluation (MVP).
 * IDL reference: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 */

import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { fetchTokenCreatorSolscan, getSolscanApiKeyFromEnv } from "./solscan-token.mjs";

/** Global initial virtual token reserves (pump docs; tune if program global changes). */
export const INITIAL_VIRTUAL_TOKEN_RESERVES = 1073000000000000n;

const BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const BUY_EXACT_SOL_IN_DISC = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);

const MINT_IX_INDEX = 2;
const BONDING_CURVE_IX_INDEX = 3;
const USER_IX_INDEX = 6;

function u64FromBuf(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

function discEq(buf, disc) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(disc);
}

export function decodeIxData(dataB58) {
  if (!dataB58 || typeof dataB58 !== "string") return null;
  let raw;
  try {
    raw = Buffer.from(bs58.decode(dataB58));
  } catch {
    return null;
  }
  return raw;
}

/** @param {import('@solana/web3.js').ParsedTransactionWithMeta} parsed */
export function flatInstructions(parsed) {
  const out = [];
  const msg = parsed?.transaction?.message;
  if (!msg?.instructions?.length) return out;
  const base = msg.instructions;
  for (const ix of base) out.push(ix);
  const inner = parsed.meta?.innerInstructions;
  if (inner?.length) {
    for (const group of inner) {
      for (const ix of group.instructions) out.push(ix);
    }
  }
  return out;
}

function programIdStr(ix) {
  const p = ix.programId;
  if (typeof p === "string") return p;
  if (p?.toBase58) return p.toBase58();
  return null;
}

/**
 * @returns {{ kind: 'buy'|'buy_exact_sol_in', solLamportsApprox: bigint, tokenAmount: bigint, maxSolCostLamports?: bigint } | null}
 * Untuk `buy`: argumen ix adalah token amount + **max_sol_cost** (plafon slippage), BUKAN SOL aktual — jangan pakai itu sebagai ukuran whale.
 */
export function parsePumpBuyPayload(dataBuf) {
  if (!dataBuf || dataBuf.length < 16) return null;
  if (discEq(dataBuf, BUY_DISC)) {
    const amount = u64FromBuf(dataBuf, 8);
    const maxSolCost = u64FromBuf(dataBuf, 16);
    return {
      kind: "buy",
      tokenAmount: amount,
      maxSolCostLamports: maxSolCost,
      solLamportsApprox: maxSolCost,
    };
  }
  if (discEq(dataBuf, BUY_EXACT_SOL_IN_DISC)) {
    const spendable = u64FromBuf(dataBuf, 8);
    return { kind: "buy_exact_sol_in", solLamportsApprox: spendable, tokenAmount: 0n };
  }
  return null;
}

function accountKeyStr(k) {
  if (typeof k === "string") return k;
  if (k?.pubkey?.toBase58) return k.pubkey.toBase58();
  if (typeof k?.toBase58 === "function") return k.toBase58();
  return null;
}

/**
 * Perkiraan SOL yang benar-benar keluar dari akun user (native), dari pre/post balances.
 * Dipakai untuk instruksi `buy` (max_sol_cost di ix bukan nilai aktual).
 */
export function estimateUserSolSpendLamports(parsed, userPubkey) {
  const meta = parsed?.meta;
  if (!meta?.preBalances || !meta?.postBalances) return null;
  const msg = parsed.transaction?.message;
  const keys = msg?.accountKeys;
  if (!keys?.length) return null;

  let userPk;
  try {
    userPk = new PublicKey(userPubkey);
  } catch {
    return null;
  }

  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    const s = accountKeyStr(keys[i]);
    if (!s) continue;
    try {
      if (userPk.equals(new PublicKey(s))) {
        idx = i;
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (idx < 0 || idx >= meta.preBalances.length) return null;

  const pre = BigInt(meta.preBalances[idx]);
  const post = BigInt(meta.postBalances[idx]);
  const delta = pre - post;
  if (delta <= 0n) return null;

  const fee = BigInt(meta.fee ?? 0);
  const fpStr = accountKeyStr(keys[0]);
  let spend = delta;
  if (fpStr) {
    try {
      if (new PublicKey(fpStr).equals(userPk)) {
        spend = delta - fee;
      }
    } catch {
      /* ignore */
    }
  }

  if (spend <= 0n) return null;
  return spend;
}

/**
 * @param {string} pumpProgramId
 * @param {import('@solana/web3.js').ParsedTransactionWithMeta} parsed
 */
export function resolveIxAccounts(ix, message) {
  if (!Array.isArray(ix?.accounts) || !message?.accountKeys) return [];
  const keys = message.accountKeys;
  return ix.accounts.map((a) => {
    if (typeof a === "string") return a;
    if (typeof a === "number") {
      const k = keys[a];
      if (k == null) return null;
      return typeof k === "string" ? k : k.pubkey;
    }
    if (a?.pubkey != null) return String(a.pubkey);
    if (typeof a?.toBase58 === "function") return a.toBase58();
    return null;
  });
}

export function findPumpBuyInTx(pumpProgramId, parsed) {
  const msg = parsed?.transaction?.message;
  if (!msg) return null;
  const flat = flatInstructions(parsed);
  for (const ix of flat) {
    const pid = programIdStr(ix);
    if (pid !== pumpProgramId) continue;
    const raw = decodeIxData(ix.data);
    const payload = parsePumpBuyPayload(raw);
    if (!payload) continue;
    const accounts = resolveIxAccounts(ix, msg);
    if (accounts.length <= USER_IX_INDEX || accounts.some((x) => !x)) continue;
    const mint = accounts[MINT_IX_INDEX];
    const bondingCurve = accounts[BONDING_CURVE_IX_INDEX];
    const user = accounts[USER_IX_INDEX];

    const fromMeta = estimateUserSolSpendLamports(parsed, user);
    let solLamportsApprox;
    let solEstimateSource;
    if (fromMeta != null && fromMeta > 0n) {
      solLamportsApprox = fromMeta;
      solEstimateSource = "user_balance_delta";
    } else if (payload.kind === "buy_exact_sol_in") {
      solLamportsApprox = payload.solLamportsApprox;
      solEstimateSource = "ix_exact_sol_in";
    } else {
      solLamportsApprox = 0n;
      solEstimateSource = "buy_no_balance_meta";
    }

    return {
      ...payload,
      mint,
      bondingCurve,
      user,
      solLamportsApprox,
      solEstimateSource,
    };
  }
  return null;
}

export function decodeBondingCurveAccount(data) {
  if (!data || data.length < 56) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const off = 8;
  const virtual_token_reserves = buf.readBigUInt64LE(off);
  const virtual_sol_reserves = buf.readBigUInt64LE(off + 8);
  const real_token_reserves = buf.readBigUInt64LE(off + 16);
  const real_sol_reserves = buf.readBigUInt64LE(off + 24);
  const token_total_supply = buf.readBigUInt64LE(off + 32);
  const complete = buf.readUInt8(off + 40) !== 0;
  return {
    virtual_token_reserves,
    virtual_sol_reserves,
    real_token_reserves,
    real_sol_reserves,
    token_total_supply,
    complete,
  };
}

export async function evalNetworkCongestion(connection, policy) {
  const f = policy.filters?.networkCongestion;
  if (!f?.enabled) return { hit: false, detail: "disabled" };
  const maxFee = f.maxRecentPriorityFeeMicrolamports ?? 500_000;
  let samples;
  try {
    samples = await connection.getRecentPrioritizationFees();
  } catch (e) {
    return { hit: false, detail: `rpc_error:${e?.message ?? e}` };
  }
  if (!samples?.length) return { hit: false, detail: "no_samples" };
  const last = samples.slice(-30);
  const peak = Math.max(...last.map((s) => s.prioritizationFee ?? 0));
  const median = [...last.map((s) => s.prioritizationFee ?? 0)].sort((a, b) => a - b)[
    Math.floor(last.length / 2)
  ];
  const hit = peak > maxFee;
  return { hit, detail: { peak, median, maxFee, window: last.length } };
}

export async function evalMarketCapLike(connection, policy, bondingCurvePk) {
  const f = policy.filters?.marketCapEntry;
  if (!f?.enabled) return { hit: false, detail: "disabled" };
  const mult = f.skipIfPriceMultipleFromInferredLaunchGte ?? 5;
  let pk;
  try {
    pk = new PublicKey(bondingCurvePk);
  } catch {
    return { hit: false, detail: "bad_bonding_curve_pubkey" };
  }

  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info?.data) return { hit: false, detail: "no_curve_account" };
  const curve = decodeBondingCurveAccount(info.data);
  if (!curve) return { hit: false, detail: "decode_curve_failed" };

  if (curve.complete) {
    return { hit: true, detail: { reason: "bonding_curve_complete", curve } };
  }

  const vt = curve.virtual_token_reserves;
  if (vt > 0n) {
    const ratio = Number(INITIAL_VIRTUAL_TOKEN_RESERVES) / Number(vt);
    if (ratio >= mult) {
      return {
        hit: true,
        detail: {
          reason: "virtual_reserve_drawdown",
          ratio,
          mult,
          curve,
        },
      };
    }
  }

  return { hit: false, detail: { curve, ratioFromInitial: Number(INITIAL_VIRTUAL_TOKEN_RESERVES) / Number(vt || 1n) } };
}

export async function evalTopHoldersSol(connection, policy, mintPkStr) {
  const f = policy.filters?.topHolderBalanceSol;
  if (!f?.enabled) return { hit: false, detail: "disabled" };

  const thresholdSol = f.thresholdSol ?? 0.2;
  const maxSample = Math.min(10, f.sampleTopHolders ?? 5);
  const flagIfAllBelow = f.flagIfAllSampleBelowThreshold !== false;

  let mint;
  try {
    mint = new PublicKey(mintPkStr);
  } catch {
    return { hit: false, detail: "bad_mint" };
  }

  let largest;
  try {
    const res = await connection.getTokenLargestAccounts(mint);
    largest = res?.value ?? [];
  } catch (e) {
    return { hit: false, detail: `token_largest_error:${e?.message ?? e}` };
  }

  const sample = largest.slice(0, maxSample);
  if (!sample.length) return { hit: false, detail: "no_holders" };

  const ownerBals = [];
  for (const { address } of sample) {
    try {
      const parsed = await connection.getParsedAccountInfo(new PublicKey(address));
      const owner =
        parsed?.value?.data?.parsed?.info?.owner ??
        parsed?.value?.data?.parsed?.info?.owner?.toString?.();
      if (!owner) continue;
      const lamports = await connection.getBalance(new PublicKey(owner), "confirmed");
      ownerBals.push(lamports / 1e9);
    } catch {
      continue;
    }
  }

  if (!ownerBals.length) return { hit: false, detail: "no_owner_balances" };

  const allBelow = ownerBals.every((s) => s < thresholdSol);
  const hit = flagIfAllBelow && allBelow;
  return {
    hit,
    detail: { sampleSolBalances: ownerBals, thresholdSol, allBelow },
  };
}

function walletMatchesAnyRule(wallet, rules) {
  if (!wallet || !Array.isArray(rules) || rules.length === 0) return false;
  return rules.some((r) => {
    if (typeof r !== "string" || r.trim() === "") return false;
    const rule = r.trim();
    return wallet === rule || wallet.startsWith(rule);
  });
}

export function ownerNetSolDeltaLamports(parsed, ownerPkStr) {
  const msg = parsed?.transaction?.message;
  const keys = msg?.accountKeys;
  const meta = parsed?.meta;
  if (!keys?.length || !meta?.preBalances || !meta?.postBalances) return null;

  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    const s = accountKeyStr(keys[i]);
    if (!s) continue;
    if (s === ownerPkStr) {
      idx = i;
      break;
    }
  }
  if (idx < 0 || idx >= meta.preBalances.length || idx >= meta.postBalances.length) return null;

  const pre = BigInt(meta.preBalances[idx]);
  const post = BigInt(meta.postBalances[idx]);
  let delta = post - pre; // + berarti saldo SOL owner naik

  // Jika owner adalah fee payer (accountKeys[0]), tambahkan fee agar delta trading tidak bias fee.
  const feePayer = accountKeyStr(keys[0]);
  if (feePayer === ownerPkStr) {
    delta += BigInt(meta.fee ?? 0);
  }
  return delta;
}

export function ownerTokenDeltaForMintRaw(parsed, ownerPkStr, mintPkStr) {
  const meta = parsed?.meta;
  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];
  const getAmt = (tb) => {
    const a = tb?.uiTokenAmount?.amount;
    if (typeof a !== "string") return 0n;
    try {
      return BigInt(a);
    } catch {
      return 0n;
    }
  };

  let preSum = 0n;
  for (const tb of pre) {
    if (tb?.owner === ownerPkStr && tb?.mint === mintPkStr) preSum += getAmt(tb);
  }
  let postSum = 0n;
  for (const tb of post) {
    if (tb?.owner === ownerPkStr && tb?.mint === mintPkStr) postSum += getAmt(tb);
  }
  return postSum - preSum; // + berarti token owner bertambah
}

/**
 * Flag wallet dev/dumper:
 * 1) blacklist wallet (exact/prefix),
 * 2) pola sell beruntun setelah buy di mint yang sama dalam X menit.
 */
export async function evalWalletDevOrDumper(connection, policy, buyMeta) {
  const f = policy.filters?.walletDumper;
  if (!f?.enabled) return { hit: false, detail: "disabled" };

  const wallet = buyMeta?.user;
  const mint = buyMeta?.mint;
  if (!wallet || !mint) return { hit: false, detail: "missing_wallet_or_mint" };

  const blacklist = f.blacklistWallets ?? [];
  if (walletMatchesAnyRule(wallet, blacklist)) {
    return { hit: true, detail: { reason: "wallet_blacklist", wallet, rules: blacklist } };
  }

  /** Solscan Pro: bandingkan pembeli dengan Creator token (bukan heuristik sell RPC). */
  const solscanOn = f.solscanTokenCreatorCheck !== false;
  if (solscanOn) {
    const solscanKey = getSolscanApiKeyFromEnv();
    if (solscanKey) {
      const sc = await fetchTokenCreatorSolscan(mint, { apiKey: solscanKey });
      if (sc.ok && sc.creator && sc.creator === wallet) {
        return {
          hit: true,
          detail: {
            reason: "token_creator_wallet",
            wallet,
            mint,
            creator: sc.creator,
            source: "solscan_token_meta",
          },
        };
      }
    }
  }

  const lookbackSignatures = Math.max(10, f.lookbackSignatures ?? 50);
  const maxTxDecode = Math.max(5, f.maxTxDecode ?? 25);
  const windowMinutes = Math.max(1, f.windowMinutes ?? 60);
  const minSellAfterBuy = Math.max(1, f.minSellAfterBuy ?? 2);
  const minSoldToBoughtRatio = Math.max(0.1, f.minSoldToBoughtRatio ?? 0.8);
  const nowMs = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  let sigs;
  try {
    sigs = await connection.getSignaturesForAddress(new PublicKey(wallet), {
      limit: lookbackSignatures,
    });
  } catch (e) {
    return { hit: false, detail: `wallet_sig_error:${e?.message ?? e}` };
  }
  if (!sigs?.length) return { hit: false, detail: "no_wallet_signatures" };

  const txs = [];
  for (const s of sigs.slice(0, maxTxDecode)) {
    try {
      const parsed = await connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!parsed || parsed.meta?.err) continue;

      const tokDelta = ownerTokenDeltaForMintRaw(parsed, wallet, mint);
      if (tokDelta === 0n) continue;
      const solDelta = ownerNetSolDeltaLamports(parsed, wallet);
      if (solDelta == null) continue;

      const tsMs =
        typeof parsed.blockTime === "number" && parsed.blockTime > 0
          ? parsed.blockTime * 1000
          : nowMs;
      if (nowMs - tsMs > windowMs) continue;

      let side = null;
      if (tokDelta > 0n && solDelta < 0n) side = "buy";
      else if (tokDelta < 0n && solDelta > 0n) side = "sell";
      if (!side) continue;

      txs.push({ side, tsMs, tokDelta, solDelta, signature: s.signature });
    } catch {
      continue;
    }
  }

  if (!txs.length) return { hit: false, detail: "no_buy_sell_pattern_in_window" };

  txs.sort((a, b) => a.tsMs - b.tsMs);
  const buys = txs.filter((t) => t.side === "buy");
  if (!buys.length) return { hit: false, detail: "no_buy_pattern" };
  const latestBuy = buys[buys.length - 1];

  const sellsAfter = txs.filter((t) => t.side === "sell" && t.tsMs >= latestBuy.tsMs);
  const soldTokens = sellsAfter.reduce((acc, t) => acc + (-t.tokDelta), 0n);
  const boughtTokens = buys
    .filter((t) => t.tsMs >= latestBuy.tsMs - windowMs)
    .reduce((acc, t) => acc + t.tokDelta, 0n);

  let ratio = 0;
  if (boughtTokens > 0n) {
    ratio = Number((soldTokens * 10000n) / boughtTokens) / 10000;
  }

  const hit = sellsAfter.length >= minSellAfterBuy && ratio >= minSoldToBoughtRatio;
  return {
    hit,
    detail: {
      reason: hit ? "sell_after_buy_pattern" : "below_threshold",
      wallet,
      mint,
      windowMinutes,
      sellsAfterBuy: sellsAfter.length,
      minSellAfterBuy,
      soldToBoughtRatio: ratio,
      minSoldToBoughtRatio,
      latestBuySignature: latestBuy.signature,
    },
  };
}

export async function evaluateRedFlags(connection, policy, buyMeta) {
  /** @type {{ flag: string, detail: unknown }[]} */
  const hits = [];
  const notes = [];
  if (policy.filters?.holderFreshFunding?.enabled) {
    notes.push({
      note: "holder_fresh_funding_enabled_but_not_implemented",
    });
  }

  const net = await evalNetworkCongestion(connection, policy);
  if (net.hit) hits.push({ flag: "network_congestion", detail: net.detail });

  const mcap = await evalMarketCapLike(connection, policy, buyMeta.bondingCurve);
  if (mcap.hit) hits.push({ flag: "market_cap_or_momentum_bad", detail: mcap.detail });

  const holders = await evalTopHoldersSol(connection, policy, buyMeta.mint);
  if (holders.hit) hits.push({ flag: "top_holders_too_small", detail: holders.detail });

  const dumper = await evalWalletDevOrDumper(connection, policy, buyMeta);
  if (dumper.hit) hits.push({ flag: "wallet_dev_or_dumper", detail: dumper.detail });

  return {
    hits,
    notes,
    byFlag: Object.fromEntries(hits.map((h) => [h.flag, h.detail])),
  };
}

export {
  WALLET_INSIDER_METHODOLOGY,
  fetchEarlyPumpBuyersForMint,
  expandWalletPeersFromRecentTxs,
} from "./wallet-insider.mjs";

export {
  DEXSCREENER_API_BASE,
  DEXSCREENER_API_REFERENCE_URL,
  dexscreenerTokensV1,
  dexscreenerSearchPairs,
  dexscreenerTokenPairsV1,
  dexscreenerPairById,
} from "./dexscreener.mjs";
