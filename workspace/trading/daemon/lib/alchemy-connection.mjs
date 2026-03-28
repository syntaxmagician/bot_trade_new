/**
 * HTTP (Bearer) for one-shot RPC — key stays out of URL.
 * Watch/subscribe: many providers (incl. Alchemy WS) expect API key in wss URL, not Bearer on socket.
 */
import { Connection } from "@solana/web3.js";

export function buildAlchemyHttpConnection(policy) {
  const cluster = policy.chain?.cluster ?? "mainnet-beta";
  const base =
    cluster === "mainnet-beta"
      ? "https://solana-mainnet.g.alchemy.com/v2"
      : "https://solana-devnet.g.alchemy.com/v2";

  const fullUrl = process.env.SOLANA_RPC_URL?.trim();
  if (fullUrl) {
    return new Connection(fullUrl, "confirmed");
  }

  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing ALCHEMY_API_KEY (or SOLANA_RPC_URL). Set in daemon/.env or the shell; do not commit keys."
    );
  }

  return new Connection(base, {
    commitment: "confirmed",
    httpHeaders: { Authorization: `Bearer ${key}` },
  });
}

/** https/http RPC URL → wss/ws untuk subscription (logsSubscribe). */
function httpToWsEndpoint(httpUrl) {
  try {
    const u = new URL(httpUrl);
    if (u.protocol === "https:") {
      u.protocol = "wss:";
      return u.toString();
    }
    if (u.protocol === "http:") {
      u.protocol = "ws:";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * WSS wajib untuk `onLogs` / `logsSubscribe`. Tanpa `wsEndpoint`, banyak provider
 * hanya melayani HTTP → error "Method 'logsSubscribe' not found".
 */
export function buildAlchemyWatchConnection(policy) {
  const cluster = policy.chain?.cluster ?? "mainnet-beta";

  const fullUrl = process.env.SOLANA_RPC_URL?.trim();
  if (fullUrl) {
    const ws = httpToWsEndpoint(fullUrl);
    if (ws) {
      return new Connection(fullUrl, {
        commitment: "confirmed",
        wsEndpoint: ws,
      });
    }
    return new Connection(fullUrl, "confirmed");
  }

  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing ALCHEMY_API_KEY (or SOLANA_RPC_URL) for watch WebSocket. Set daemon/.env or shell."
    );
  }

  const http =
    cluster === "mainnet-beta"
      ? `https://solana-mainnet.g.alchemy.com/v2/${key}`
      : `https://solana-devnet.g.alchemy.com/v2/${key}`;

  const wss =
    cluster === "mainnet-beta"
      ? `wss://solana-mainnet.g.alchemy.com/v2/${key}`
      : `wss://solana-devnet.g.alchemy.com/v2/${key}`;

  return new Connection(http, {
    commitment: "confirmed",
    wsEndpoint: wss,
  });
}

export function rpcDisplayHost(policy) {
  const cluster = policy.chain?.cluster ?? "mainnet-beta";
  const fallback =
    cluster === "mainnet-beta"
      ? "https://solana-mainnet.g.alchemy.com/v2"
      : "https://solana-devnet.g.alchemy.com/v2";
  try {
    return new URL(process.env.SOLANA_RPC_URL?.trim() || fallback).host;
  } catch {
    return new URL(fallback).host;
  }
}
