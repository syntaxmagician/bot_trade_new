/**
 * Client ringan untuk [DexScreener HTTP API](https://docs.dexscreener.com/api/reference).
 * Base: https://api.dexscreener.com — rate limit umum ~60 req/menit (per endpoint; hormati di produksi).
 *
 * Catatan: API ini menyediakan pair, harga, volume, likuiditas, dll. — bukan daftar wallet
 * "Top Trader" (itu fitur UI / tidak tercantum di reference publik).
 */

export const DEXSCREENER_API_BASE = "https://api.dexscreener.com";

/** Dokumentasi resmi OpenAPI / reference. */
export const DEXSCREENER_API_REFERENCE_URL = "https://docs.dexscreener.com/api/reference";

async function readJsonOrText(res) {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  return await res.text();
}

/**
 * GET /tokens/v1/{chainId}/{tokenAddresses}
 * Beberapa mint dipisah koma (tanpa spasi), mis. "mintA,mintB".
 *
 * @param {string} chainId contoh: "solana"
 * @param {string | string[]} tokenAddresses satu atau lebih alamat token
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: true, data: unknown } | { ok: false, status: number, body: unknown }>}
 */
export async function dexscreenerTokensV1(chainId, tokenAddresses, options = {}) {
  const joined = Array.isArray(tokenAddresses) ? tokenAddresses.join(",") : tokenAddresses;
  const url = `${DEXSCREENER_API_BASE}/tokens/v1/${encodeURIComponent(chainId)}/${joined}`;
  const res = await fetch(url, { signal: options.signal });
  const body = await readJsonOrText(res);
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, data: body };
}

/**
 * GET /latest/dex/search?q=...
 *
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function dexscreenerSearchPairs(query, options = {}) {
  const url = new URL(`${DEXSCREENER_API_BASE}/latest/dex/search`);
  url.searchParams.set("q", query);
  const res = await fetch(url.toString(), { signal: options.signal });
  const body = await readJsonOrText(res);
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, data: body };
}

/**
 * GET /token-pairs/v1/{chainId}/{tokenAddress}
 *
 * @param {string} chainId
 * @param {string} tokenAddress
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function dexscreenerTokenPairsV1(chainId, tokenAddress, options = {}) {
  const url = `${DEXSCREENER_API_BASE}/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`;
  const res = await fetch(url, { signal: options.signal });
  const body = await readJsonOrText(res);
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, data: body };
}

/**
 * GET /latest/dex/pairs/{chainId}/{pairId}
 *
 * @param {string} chainId
 * @param {string} pairId alamat pair (pool)
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function dexscreenerPairById(chainId, pairId, options = {}) {
  const url = `${DEXSCREENER_API_BASE}/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairId)}`;
  const res = await fetch(url, { signal: options.signal });
  const body = await readJsonOrText(res);
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, data: body };
}
