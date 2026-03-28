/**
 * Estimasi "MCAP (SOL)" dari akun bonding curve pump.fun.
 * Mengikuti pola umum: marketCap ≈ virtual_sol_reserves / 1e9 (lamports → SOL).
 * @see https://solana.stackexchange.com/questions/19043/how-to-calculate-the-price-and-the-market-cap-of-a-pump-fun-token-knowing-how-ma
 *
 * Angka di UI DexScreener/pump bisa sedikit beda (rounding / definisi) — pakai policy.mcapSolScale jika perlu.
 */

import { PublicKey } from "@solana/web3.js";
import { decodeBondingCurveAccount } from "./pump-analyze.mjs";

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} bondingCurvePkStr
 * @param {{ mcapSolScale?: number }} [opts] kalikan hasil (default 1)
 */
export async function getPumpBondingCurveMcapSol(connection, bondingCurvePkStr, opts = {}) {
  const scale = opts.mcapSolScale ?? 1;
  let pk;
  try {
    pk = new PublicKey(bondingCurvePkStr);
  } catch {
    return { ok: false, error: "bad_bonding_curve" };
  }
  const info = await connection.getAccountInfo(pk, "confirmed");
  if (!info?.data) return { ok: false, error: "no_account" };
  const curve = decodeBondingCurveAccount(info.data);
  if (!curve) return { ok: false, error: "decode_failed" };
  if (curve.complete) {
    return { ok: true, complete: true, mcapSol: null, curve };
  }
  const mcapSol = (Number(curve.virtual_sol_reserves) / 1e9) * scale;
  return { ok: true, complete: false, mcapSol, curve };
}
