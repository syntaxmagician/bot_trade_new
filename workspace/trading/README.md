# Trading scaffold (pump.fun)

Contract between your **daemon** (Solana RPC, 24/7) and **OpenClaw** (policy, pause, summaries).

## Files

| File | Who writes | Purpose |
|------|------------|---------|
| `policy.json` | Human / OpenClaw | Thresholds, filters, execution caps. **No private keys.** |
| `state.json` | Daemon | Counters, open positions, last error. |
| `signals.jsonl` | Daemon | One JSON object per line (see example below this table). |
| `PAUSE` | Human / OpenClaw | If this file **exists** (empty is fine), daemon must **not** open new positions. |

Example `signals.jsonl` line:

```json
{"ts":"2026-03-26T12:00:00.000Z","mint":"<mint>","action":"skip","redFlagCount":2,"redFlags":["network_congestion","market_cap_or_momentum_bad"],"txSig":"<signature>"}
```

## Red-flag rule

Count enabled filters that fail. If count ≥ `safety.skipIfRedFlagsGte` → **skip**. Otherwise → **would_buy** (or execute when `execution.mode` allows).

## `execution.mode`

- `log_only` — record decisions only (safe for MVP).
- Later: e.g. `live` when your daemon signs txs from env-sealed keys.

## Program ID

`chain.pumpProgramId` is the public pump.fun program on mainnet (verify in [pump-public-docs](https://github.com/pump-fun/pump-public-docs) if upgrades occur).

## Alchemy free tier

Holder / funding traces expensive on pure RPC; leave `holderFreshFunding.enabled` false until you add an indexer or tight sampling.

## Alur scout (`npm run scout`)

1. Ambil signature terbaru yang memanggil program pump.fun (batas `policy.scan`).
2. Decode transaksi (RPC `getParsedTransaction`) sampai menemukan instruksi **`buy`** atau **`buy_exact_sol_in`** dengan estimasi SOL (lamports) ≥ `whaleSignal.minBuySol` → itu **kandidat whale** (tahap 1).
3. Hitung **red flag** yang enabled di `policy.filters` (jejaring; pasar/curve; top holder sampel). `holderFreshFunding` jika diaktifkan hanya menulis **note**, belum dihitung sebagai flag.
4. Jika jumlah flag ≥ `safety.skipIfRedFlagsGte` atau file `PAUSE` ada → `action: skip` / `skip_paused`; kalau tidak → `would_buy` (selama `execution.mode` masih `log_only`, tidak ada transaksi kirim).
5. Satu baris JSON ditambahkan ke `signals.jsonl` (`kind: scout_pipeline`).

### Streaming (`npm run watch`)

`scout-watch.mjs` memakai **WebSocket `logsSubscribe`** untuk transaksi yang **mention** program pump.fun, lalu pipeline yang sama (whale ≥ `minBuySol` → red flags → `signals.jsonl`).

```powershell
cd workspace/trading/daemon
$env:ALCHEMY_API_KEY="..."
npm run watch
```

**Penting:** banyak provider (termasuk Alchemy) meng‑autentikasi **WebSocket** lewat **API key di URL** `wss://…/v2/<key>`. Skrip watch memakai itu. **`npm run scout`** tetap memakai **Bearer** tanpa key di path — lebih aman untuk one‑shot HTTP.

Throttling di `policy.watch` (`minIntervalMs`, `maxQueue`) membantu tidak meledak di **500 CU/s**. `Ctrl+C` menghentikan subscription.

## Menjalankan percobaan (scout)

Ini **bukan** eksekusi beli — hanya cek RPC + beberapa signature terbaru untuk program pump.fun, lalu menulis `state.json` dan satu baris ke `signals.jsonl`.

1. Pasang dependensi (sekali):

```bash
cd workspace/trading/daemon
npm install
```

2. Set API key **hanya di shell** (PowerShell). Skrip memakai **`Authorization: Bearer`** ke `https://solana-mainnet.g.alchemy.com/v2` (kunci **tidak** di path):

```powershell
$env:ALCHEMY_API_KEY="paste_key_di_sini"
npm run scout
```

Alternatif: URL penuh (jika Anda pakai cara lain / provider lain):

```powershell
$env:SOLANA_RPC_URL="https://..."
npm run scout
```

Jika masih **401**: pastikan di Alchemy app Anda sudah aktifkan **Solana** + jaringan yang dipakai (`policy.json` → `chain.cluster`), dan kunci disalin lengkap. Coba **buat API key baru** di app yang sama.

3. Cek output: `Scout OK`, lalu buka `trading/state.json` dan baris terakhir `trading/signals.jsonl`.

Untuk **pause** entri nanti (saat sudah ada eksekusi): buat file kosong `trading/PAUSE`.

**Keamanan:** kalau kunci pernah bocor di tempat yang tidak aman, buat **kunci baru** di [Alchemy dashboard](https://dashboard.alchemy.com) dan cabut yang lama.
