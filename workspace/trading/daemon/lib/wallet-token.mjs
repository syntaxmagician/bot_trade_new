import { PublicKey } from "@solana/web3.js";

/**
 * Total raw token amount (smallest units) for `mint` owned by `owner` (all token accounts).
 * @param {import('@solana/web3.js').Connection} connection
 * @param {string} ownerBase58
 * @param {string} mintBase58
 */
export async function getWalletTokenRawAmount(connection, ownerBase58, mintBase58) {
  const owner = new PublicKey(ownerBase58);
  const res = await connection.getParsedTokenAccountsByOwner(owner);
  let total = 0n;
  for (const { account } of res.value) {
    const info = account.data?.parsed?.info;
    if (info?.mint !== mintBase58) continue;
    const amt = info?.tokenAmount?.amount;
    if (amt != null) total += BigInt(String(amt));
  }
  return total;
}
