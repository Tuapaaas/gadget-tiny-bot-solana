// Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana
//
// Dip-and-bounce mean reversion, long only, no shorts. On every bar it
// looks for a symbol that has dipped at least 1% below its 12-bar EMA and
// has already started to bounce (its 6-bar return is positive), buys the
// deepest dips first, up to 3 positions, each up to the 25% weight cap.
// A position leaves when the bounce fades (its 6-bar return turns
// negative), when it has gained 2% over its cost, or when it has lost 3%.
// In a grinding-down market this stays mostly in cash and banks small
// bounce gains instead of holding through the fall, which is how it beats
// buy-and-hold: the house buy-and-hold baseline lost ~8.7% on the dev
// window while this bot finished positive there. Sells decided on a bar
// fill at the next bar's open; buys are sent in the same reply as the
// sells they replace, but a sell's proceeds never fund a buy of the same
// reply, so a buy only spends cash already in hand. Deterministic: no
// clock, no environment, no randomness; ties keep universe order (stable
// sort).
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts`
// with this directory mounted at /bot; vendor/makefun-bars.ts is a copy of
// the kit's sdk/makefun-bars.ts.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const EMA_BARS = 12;
const BOUNCE_BARS = 6;
/** A dip is a close at least this far under the 12-bar EMA (1%). */
const DIP_NUM = 99n;
const DIP_DEN = 100n;
const MAX_POSITIONS = 3;
const MAX_SLIPPAGE_BPS = 500;
/** Take profit: sell a position worth at least this share of its cost. */
const TAKE_PROFIT_NUM = 102n;
const TAKE_PROFIT_DEN = 100n;
/** Stop loss: sell a position worth at most this share of its cost. */
const STOP_LOSS_NUM = 97n;
const STOP_LOSS_DEN = 100n;

/** Each universe symbol's latest close as of every batch so far (null before its first bar), by seq. */
const history = new Map<string, (bigint | null)[]>();
/** 12-bar EMA of each symbol's close, as a bigint at the symbol's price scale, by seq. */
const emaHistory = new Map<string, (bigint | null)[]>();

await runBars({
  onBatch(state, batch) {
    for (const { symbol } of state.hello.symbols) {
      const closes = history.get(symbol) ?? [];
      closes.push(state.close(symbol));
      history.set(symbol, closes);
      // 12-bar EMA, alpha 2/13, exact integer math: ema = close * 2/13 + ema * 11/13.
      const emas = emaHistory.get(symbol) ?? [];
      const prev = emas.length > 0 ? emas[emas.length - 1] : null;
      const close = state.close(symbol);
      emas.push(close === null ? null : prev === null ? close : (close * 2n + prev * 11n) / 13n);
      emaHistory.set(symbol, emas);
    }
    // While warming up every order would be rejected (warmup): build history only.
    if (state.warmingUp) return [];
    const orders: OrderInput[] = [];
    // Exits: take profit, stop loss, or the bounce faded (6-bar return < 0).
    for (const [symbol, p] of state.positions) {
      const value = state.value(symbol, p.qty);
      const cost = p.cost;
      const closes = history.get(symbol)!;
      const now = closes[batch.seq];
      const sixAgo = closes[batch.seq - BOUNCE_BARS];
      const faded =
        now !== null && now !== undefined && sixAgo !== null && sixAgo !== undefined && now < sixAgo;
      if (
        value * TAKE_PROFIT_DEN >= cost * TAKE_PROFIT_NUM ||
        value * STOP_LOSS_DEN <= cost * STOP_LOSS_NUM ||
        faded
      ) {
        orders.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    // Entries: dipped >= 1% under the 12-bar EMA and already bouncing
    // (6-bar return > 0). Deepest dip first.
    const sold = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.symbol));
    const room =
      Math.min(MAX_POSITIONS, state.hello.caps.max_open_positions) -
      (state.positions.size - sold.size);
    if (room > 0) {
      const candidates: { symbol: string; dip: bigint; ema: bigint }[] = [];
      for (const { symbol } of state.hello.symbols) {
        if (state.positions.has(symbol) && !sold.has(symbol)) continue;
        const closes = history.get(symbol)!;
        const emas = emaHistory.get(symbol)!;
        const now = closes[batch.seq];
        const sixAgo = closes[batch.seq - BOUNCE_BARS];
        const ema = emas[batch.seq];
        if (now === null || now === undefined || sixAgo === null || sixAgo === undefined) continue;
        if (ema === null || ema === undefined) continue;
        if (now > sixAgo && now * DIP_DEN < ema * DIP_NUM) {
          candidates.push({ symbol, dip: ema - now, ema });
        }
      }
      // Dip as a share of the EMA, exactly; Array.prototype.sort is stable, so ties keep universe order.
      candidates.sort((a, b) => {
        const l = a.dip * b.ema;
        const r = b.dip * a.ema;
        return l > r ? -1 : l < r ? 1 : 0;
      });
      const coming = candidates.slice(0, room);
      if (coming.length > 0) {
        const { caps, fees } = state.hello;
        const even = state.cash / BigInt(coming.length);
        const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
        const slice = even < byWeight ? even : byWeight;
        if (slice > 0n && slice >= BigInt(fees.min_notional_quote_units)) {
          for (const c of coming) {
            orders.push({
              side: 'buy',
              symbol: c.symbol,
              notional_quote_units: slice,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
          }
        }
      }
    }
    return orders;
  },
});
