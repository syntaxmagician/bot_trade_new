/**
 * Pengganti logsSubscribe untuk RPC yang tidak mendukung (mis. Alchemy Solana WS).
 * Poll HTTP: getSignaturesForAddress(program) — baru setelah "prime" batch pertama.
 */

/**
 * @param {object} o
 * @param {import('@solana/web3.js').Connection} o.connection
 * @param {import('@solana/web3.js').PublicKey} o.pumpProgramKey
 * @param {(sig: string) => boolean} o.rememberSignature
 * @param {(sig: string) => void} o.enqueue
 * @param {number} [o.pollIntervalMs]
 * @param {number} [o.limit]
 */
export function startPumpSignaturePoll(o) {
  const pollIntervalMs = o.pollIntervalMs ?? 2500;
  const limit = o.limit ?? 30;
  let first = true;

  const tick = () => {
    void (async () => {
      try {
        const sigs = await o.connection.getSignaturesForAddress(o.pumpProgramKey, { limit });
        if (first) {
          for (const { signature, err } of sigs) {
            if (err || !signature) continue;
            o.rememberSignature(signature);
          }
          first = false;
          console.log(
            "[poll] primed",
            sigs.length,
            "recent signatures (skipped decode — next polls only enqueue new txs)"
          );
          return;
        }
        for (const { signature, err } of sigs) {
          if (err || !signature) continue;
          o.enqueue(signature);
        }
      } catch (e) {
        console.error("[poll]", e?.message ?? e);
      }
    })();
  };

  const timer = setInterval(tick, pollIntervalMs);
  tick();
  return () => clearInterval(timer);
}
