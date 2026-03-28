/**
 * Jupiter — quote + swap (SOL ↔ SPL).
 * Default: api.jup.ag/swap/v1 (hostname biasanya ter-resolve walau quote-api.jup.ag ENOTFOUND).
 * Fallback: quote-api.jup.ag/v6 jika host pertama gagal di jaringan.
 *
 * Env (daemon/.env):
 * - JUPITER_QUOTE_URL / JUPITER_SWAP_URL — override URL penuh (pasangkan quote+swap satu API).
 * - JUPITER_API_KEY — dari https://portal.jup.ag (header x-api-key); sering wajib untuk api.jup.ag.
 */

import { VersionedTransaction } from "@solana/web3.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

const SYM_SWAP_URL = Symbol.for("openclaw.jupiterSwapUrl");

/** Tanpa override env: coba api.jup.ag dulu, lalu legacy quote-api. */
function quoteBaseCandidates() {
  const o = process.env.JUPITER_QUOTE_URL?.trim();
  if (o) return [o];
  return ["https://api.jup.ag/swap/v1/quote", "https://quote-api.jup.ag/v6/quote"];
}

function swapEndpoint() {
  return (
    process.env.JUPITER_SWAP_URL?.trim() || "https://api.jup.ag/swap/v1/swap"
  );
}

/** Dari URL quote → URL swap (path /quote → /swap). */
function swapUrlForQuoteBase(quoteBaseUrl) {
  if (quoteBaseUrl.endsWith("/quote")) {
    return quoteBaseUrl.slice(0, -"/quote".length) + "/swap";
  }
  return quoteBaseUrl.replace("/v6/quote", "/v6/swap");
}

function jupiterAuthHeaders() {
  const k = process.env.JUPITER_API_KEY?.trim();
  if (!k) return {};
  return { "x-api-key": k };
}

/** Detail untuk error fetch (Node sering hanya "fetch failed"; penyebab ada di .cause). */
function formatNetworkError(err) {
  const parts = [err?.message ?? String(err)];
  const c = err?.cause;
  if (c) {
    if (c.message) parts.push(c.message);
    if (c.code) parts.push(`code=${c.code}`);
    if (c.errno) parts.push(`errno=${c.errno}`);
  }
  return parts.join(" | ");
}

async function fetchWithNetworkGuard(url, init = {}) {
  const merged = {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "openclaw-pump-scout/0.1",
      ...jupiterAuthHeaders(),
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(45_000),
  };
  try {
    return { ok: true, res: await fetch(url, merged) };
  } catch (e) {
    return { ok: false, error: formatNetworkError(e) };
  }
}

function buildQuoteUrlWithBase(baseUrl, params) {
  const u = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * @param {string} inputMint
 * @param {string} outputMint
 * @param {bigint | string | number} amount raw amount (lamports for SOL, smallest token unit for SPL)
 * @param {number} slippageBps
 */
export async function jupiterQuoteV6(inputMint, outputMint, amount, slippageBps) {
  const params = {
    inputMint,
    outputMint,
    amount: typeof amount === "bigint" ? amount.toString() : String(amount),
    slippageBps,
    onlyDirectRoutes: false,
  };

  let lastHttp = null;
  let lastNetwork = null;
  let hadUnauthorized = false;

  for (const base of quoteBaseCandidates()) {
    const url = buildQuoteUrlWithBase(base, params);

    let fetched = await fetchWithNetworkGuard(url);
    if (!fetched.ok) {
      await new Promise((r) => setTimeout(r, 400));
      fetched = await fetchWithNetworkGuard(url);
    }
    if (!fetched.ok) {
      lastNetwork = fetched.error;
      continue;
    }

    const res = fetched.res;
    if (!res.ok) {
      const t = await res.text();
      lastHttp = { status: res.status, error: t };
      if (res.status === 401 || res.status === 403) hadUnauthorized = true;
      if (
        res.status === 401 ||
        res.status === 403 ||
        res.status >= 500 ||
        res.status === 429
      ) {
        continue;
      }
      return { ok: false, status: res.status, error: t };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return { ok: false, error: `invalid_json: ${e?.message ?? e}` };
    }

    data[SYM_SWAP_URL] = swapUrlForQuoteBase(base);
    return { ok: true, data };
  }

  if (lastNetwork) {
    const msg = hadUnauthorized
      ? `api.jup.ag 401/403 (butuh JUPITER_API_KEY). Fallback gagal: ${lastNetwork}`
      : lastNetwork;
    return {
      ok: false,
      error: msg,
      networkError: true,
      hint: hadUnauthorized
        ? "Daftar key gratis di https://portal.jup.ag → set JUPITER_API_KEY di daemon/.env"
        : "Perbaiki DNS/firewall untuk quote-api.jup.ag atau gunakan JUPITER_API_KEY + api.jup.ag.",
    };
  }
  if (lastHttp) {
    return {
      ok: false,
      status: lastHttp.status,
      error: lastHttp.error,
      hint:
        lastHttp.status === 401 || lastHttp.status === 403
          ? "Set JUPITER_API_KEY di daemon/.env (portal.jup.ag)."
          : undefined,
    };
  }
  return { ok: false, error: "no_quote_candidates" };
}

/**
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').Keypair} keypair
 * @param {object} quoteResponse from jupiterQuoteV6
 */
export async function jupiterSwapV6(connection, keypair, quoteResponse) {
  const swapUrl = quoteResponse[SYM_SWAP_URL] ?? swapEndpoint();
  const fetched = await fetchWithNetworkGuard(swapUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!fetched.ok) {
    return { ok: false, error: fetched.error, networkError: true };
  }
  const res = fetched.res;
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: t };
  }
  const { swapTransaction } = await res.json();
  if (!swapTransaction) {
    return { ok: false, error: "no_swapTransaction" };
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([keypair]);
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 2,
  });
  try {
    await confirmSignature(connection, sig);
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), signature: sig };
  }
  return { ok: true, signature: sig };
}

/** @param {import('@solana/web3.js').Connection} connection */
async function confirmSignature(connection, sig) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const st = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st?.value?.[0];
    if (v?.err) throw new Error(`tx_err:${JSON.stringify(v.err)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("confirm_timeout");
}
