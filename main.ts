// Pump.fun Sharpe Sprint — "cleanest paper bot": a fast, selective momentum scalp.
//
// Idea, from the dev window's own price paths: a fresh pump.fun coin bursts in the
// slot it is created, then fades for minutes. Buying the burst is buying the top, so
// this bot only buys a coin that is STILL pumping after the burst: its price must be
// at least 1.5x its creation price and at least 1.2x where it stood 350 slots ago.
// It risks a fixed 0.01 SOL per coin (the smallest stake that counts as a round
// trip), holds at most 5 coins, and gets out fast: take profit at +8%, a trailing
// stop once +4% up, a hard stop at -4%, and a time stop after 150 slots (~30 s).
// Quick exits keep the hourly equity curve smooth, which is what the Sharpe ranking
// rewards; slow losers are never allowed to sit and bleed.
//
// Everything is exact BigInt arithmetic on the reserves the harness reports: no
// floats, no clock, no randomness, no network. Two runs on the same data decide the
// same orders, so the two grading runs agree byte for byte.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// --- tuned constants (swept on the kit's dev window; see README) ---
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL per coin
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 5_000;
const MAX_AGE_SLOTS = 2_800; // only fresh coins (~10 min)
const LOOKBACK_SLOTS = 350; // momentum window (~75 s)
const CREATE_MULT_NUM = 3n; // price >= 1.5x creation price
const CREATE_MULT_DEN = 2n;
const RECENT_MULT_NUM = 6n; // price >= 1.2x the price LOOKBACK_SLOTS ago
const RECENT_MULT_DEN = 5n;
const TAKE_PROFIT_NUM = 108n; // mark >= 1.08x cost
const TRAIL_ARM_NUM = 104n; // trailing stop arms once peak >= 1.04x cost
const TRAIL_DROP_NUM = 96n; // ... then exits at 0.96x the peak
const STOP_NUM = 96n; // hard stop: mark <= 0.96x cost
const MAX_HOLD_SLOTS = 150; // time stop (~30 s)
const PCT_DEN = 100n;

// Curve fees the harness charges (hello.fees fallbacks; the dev data charges 95/30).
const PROTOCOL_BPS = 95n;
const CREATOR_BPS = 30n;
const BPS_DEN = 10_000n;

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Net lamports closing `tokens` would pay now (curve quote minus curve fees minus one tx fee), or 0. */
function closeValue(vq: bigint, vt: bigint, rq: bigint, tokens: bigint, txFee: bigint): bigint {
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  const fee = ceilDiv(q * PROTOCOL_BPS, BPS_DEN);
  const creatorFee = ceilDiv(q * CREATOR_BPS, BPS_DEN);
  const net = q - fee - creatorFee - txFee;
  return net > 0n ? net : 0n;
}

interface CoinTrack {
  createSlot: number;
  createVq: bigint;
  createVt: bigint;
  /** (slot, vq, vt) samples from TradeEvents, oldest first, pruned to the lookback window. */
  hist: Array<{ slot: number; vq: bigint; vt: bigint }>;
}

interface HeldTrack {
  cost: bigint;
  entrySlot: number;
  peak: bigint;
}

const coins = new Map<string, CoinTrack>();
const held = new Map<string, HeldTrack>();
const decided = new Set<string>();

await runBot({
  onBatch(state, batch) {
    const txFee = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];

    // Refresh per-coin price history from this batch's trades, and record creations.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          createSlot: e.slot,
          createVq: BigInt(e.virtual_quote_reserves),
          createVt: BigInt(e.virtual_token_reserves),
          hist: [],
        });
      } else if (e.event === 'TradeEvent') {
        const track = coins.get(e.mint);
        if (track === undefined) continue;
        track.hist.push({ slot: e.slot, vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves) });
        while (track.hist.length > 0 && track.hist[0]!.slot < batch.slot - LOOKBACK_SLOTS - 50) track.hist.shift();
      }
    }

    // Sync held positions with the account; drop tracks for positions that closed.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    for (const [mint, pos] of state.positions) {
      const track = held.get(mint);
      if (track === undefined) {
        held.set(mint, { cost: pos.cost_lamports, entrySlot: state.slot, peak: 0n });
      } else {
        track.cost = pos.cost_lamports;
      }
    }

    // Mints with a sell already in flight: never send a second sell for them.
    const selling = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') selling.add(p.order.mint);
    }

    // --- exits first: take profit, trailing stop, hard stop, time stop ---
    for (const [mint, pos] of state.positions) {
      if (selling.has(mint) || orders.length >= 16) continue;
      const track = held.get(mint);
      if (track === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const mark = closeValue(curve.virtual_quote_reserves, curve.virtual_token_reserves, curve.real_quote_reserves, pos.token_amount, txFee);
      if (mark > track.peak) track.peak = mark;
      const cost = track.cost;
      if (cost <= 0n) continue;
      const exit =
        mark * PCT_DEN >= cost * TAKE_PROFIT_NUM ||
        (track.peak * PCT_DEN >= cost * TRAIL_ARM_NUM && mark * PCT_DEN <= track.peak * TRAIL_DROP_NUM) ||
        mark * PCT_DEN <= cost * STOP_NUM ||
        state.slot - track.entrySlot >= MAX_HOLD_SLOTS;
      if (exit && mark > 0n) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }

    // --- entries: one fresh, still-pumping coin at a time ---
    if (orders.length < 16) {
      let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
      let free = state.freeCashLamports();
      for (const [mint, curve] of state.curves) {
        if (orders.length >= 16 || slots <= 0) break;
        if (decided.has(mint) || curve.complete) continue;
        const track = coins.get(mint);
        if (track === undefined) continue;
        if (state.slot - track.createSlot > MAX_AGE_SLOTS) continue;
        if (state.maxBuyLamports(mint) < STAKE_LAMPORTS) continue;
        // Price must be >= 1.5x its creation price (exact cross-multiplication).
        if (curve.virtual_quote_reserves * track.createVt * CREATE_MULT_DEN < track.createVq * curve.virtual_token_reserves * CREATE_MULT_NUM) continue;
        // ... and >= 1.2x where it stood LOOKBACK_SLOTS ago. The reference sample
        // must be fresh (within 100 slots of the horizon): a coin that went quiet
        // long ago must not pass on a stale, much older price.
        const horizon = state.slot - LOOKBACK_SLOTS;
        let old: { slot: number; vq: bigint; vt: bigint } | undefined;
        for (const s of track.hist) {
          if (s.slot <= horizon) old = s;
          else break;
        }
        if (old === undefined || old.slot < horizon - 100) continue;
        if (curve.virtual_quote_reserves * old.vt * RECENT_MULT_DEN < old.vq * curve.virtual_token_reserves * RECENT_MULT_NUM) continue;
        if (free < STAKE_LAMPORTS + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: STAKE_LAMPORTS, max_slippage_bps: BUY_SLIPPAGE_BPS });
        decided.add(mint);
        slots -= 1;
        free -= STAKE_LAMPORTS + txFee;
      }
    }

    return orders;
  },

  onDone(state) {
    console.error(
      `done: cash=${state.cash} fills=${state.account.positions.length} positions left, ` +
        `decided=${decided.size} coins`,
    );
  },
});
