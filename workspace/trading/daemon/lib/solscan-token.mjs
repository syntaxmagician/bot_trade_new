/**
 * Solscan Pro API — baca creator token (Profile Summary → Creator di UI).
 *
 * Env (daemon/.env):
 * - SOLSCAN_API_KEY — wajib untuk Pro API (header `token`, lihat docs.solscan.io).
 * - SOLSCAN_PRO_API_KEY — alias opsional.
 * - SOLSCAN_API_BASE — override, default https://pro-api.solscan.io
 */

const DEFAULT_BASE = "https://pro-api.solscan.io";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Map<string, { at: number, creator: string | null, err?: string }>} */
const creatorCache = new Map();

export function getSolscanApiKeyFromEnv() {
  const k =
    process.env.SOLSCAN_API_KEY?.trim() ||
    process.env.SOLSCAN_PRO_API_KEY?.trim() ||
    "";
  return k || null;
}

function solscanBaseUrl() {
  const b = process.env.SOLSCAN_API_BASE?.trim();
  return b && b.startsWith("http") ? b.replace(/\/$/, "") : DEFAULT_BASE;
}

/**
 * @param {unknown} obj
 * @returns {string | null}
 */
function extractCreatorAddress(obj) {
  if (!obj || typeof obj !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (obj);
  const tryStr = (v) =>
    typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(v.trim()) ? v.trim() : null;

  const direct =
    tryStr(o.creator) ||
    tryStr(o.tokenCreator) ||
    tryStr(o.token_creator) ||
    tryStr(o.creatorAddress) ||
    tryStr(o.creator_address);
  if (direct) return direct;

  const creators = o.creators ?? o.creatorList;
  if (Array.isArray(creators) && creators.length > 0) {
    const first = creators[0];
    if (typeof first === "string") return tryStr(first);
    if (first && typeof first === "object") {
      const x = /** @type {Record<string, unknown>} */ (first);
      return tryStr(x.address) || tryStr(x.wallet) || tryStr(x.creator);
    }
  }

  const meta = o.metadata ?? o.tokenMetadata;
  if (meta && typeof meta === "object") {
    return extractCreatorAddress(meta);
  }
  return null;
}

/**
 * @param {unknown} body
 */
function parseCreatorFromResponseBody(body) {
  if (!body || typeof body !== "object") return null;
  const root = /** @type {Record<string, unknown>} */ (body);
  const data = root.data ?? root.result ?? root;
  if (data && typeof data === "object") {
    const c = extractCreatorAddress(data);
    if (c) return c;
  }
  return extractCreatorAddress(root);
}

/**
 * @param {string} mint
 * @param {string} apiKey
 * @returns {Promise<{ ok: true, creator: string | null } | { ok: false, error: string }>}
 */
async function fetchTokenMetaOnce(mint, apiKey) {
  const base = solscanBaseUrl();
  const headers = {
    Accept: "application/json",
    "User-Agent": "openclaw-trading/0.1",
    token: apiKey,
  };

  const tryV2 = `${base}/v2.0/token/meta?address=${encodeURIComponent(mint)}`;
  let res = await fetch(tryV2, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  let text = await res.text();
  if (!res.ok && res.status !== 404) {
    return { ok: false, error: `solscan_v2_http_${res.status}:${text.slice(0, 200)}` };
  }
  if (res.ok) {
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && body.success === false) {
        const msg = typeof body.message === "string" ? body.message : JSON.stringify(body).slice(0, 180);
        return { ok: false, error: `solscan_v2:${msg}` };
      }
      const creator = parseCreatorFromResponseBody(body);
      return { ok: true, creator };
    } catch (e) {
      return { ok: false, error: `solscan_v2_json:${e?.message ?? e}` };
    }
  }

  const tryV1 = `${base}/v1.0/token/meta?tokenAddress=${encodeURIComponent(mint)}`;
  res = await fetch(tryV1, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `solscan_v1_http_${res.status}:${text.slice(0, 200)}` };
  }
  try {
    const body = JSON.parse(text);
    const creator = parseCreatorFromResponseBody(body);
    return { ok: true, creator };
  } catch (e) {
    return { ok: false, error: `solscan_v1_json:${e?.message ?? e}` };
  }
}

/**
 * Creator token dari Solscan (cache per mint).
 *
 * @param {string} mint
 * @param {{ apiKey?: string | null, bypassCache?: boolean }} [opts]
 * @returns {Promise<{ ok: true, creator: string | null } | { ok: false, error: string }>}
 */
export async function fetchTokenCreatorSolscan(mint, opts = {}) {
  const apiKey = opts.apiKey ?? getSolscanApiKeyFromEnv();
  if (!apiKey) {
    return { ok: false, error: "missing_SOLSCAN_API_KEY" };
  }
  if (!mint || typeof mint !== "string") {
    return { ok: false, error: "bad_mint" };
  }

  if (!opts.bypassCache) {
    const hit = creatorCache.get(mint);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      if (hit.err) return { ok: false, error: hit.err };
      return { ok: true, creator: hit.creator };
    }
  }

  const out = await fetchTokenMetaOnce(mint, apiKey);
  if (!out.ok) {
    creatorCache.set(mint, { at: Date.now(), creator: null, err: out.error });
    return out;
  }
  creatorCache.set(mint, { at: Date.now(), creator: out.creator ?? null });
  return { ok: true, creator: out.creator ?? null };
}
