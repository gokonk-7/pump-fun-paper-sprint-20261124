// Ignition Spray: a multi-signal pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Angle (deliberately unlike the textbook momentum bots and unlike the kit pilots):
//   - NOT a breakout bot chasing coins at their high, NOT a dip-catcher, NOT a blind
//     at-create sniper (the sniper pilot buys within 3 slots of creation with no flow
//     confirmation at all).
//   - Tier 1 buys IGNITIONS: young coins (10-900 slots old) whose first trades CONFIRM
//     real demand — mostly buys, several distinct buyers, positive net SOL flow, no
//     big dump yet, creator still holding. Six signals must agree before one lamport
//     moves, but the bar is deliberately permissive on price: the edge is breadth +
//     skew, not picking the perfect entry.
//   - Tier 2 ("fillers") buys the same ignition shape on a LOOSER bar (3 of last 5
//     buys, 2 buyers, any net flow >= 0, age up to 3600 slots) at a token 0.015 SOL
//     stake. They exist for two measured reasons: the ignition filter alone only
//     finds ~18-19 coins per 6h window while the guardrail demands 20 distinct
//     round-tripped coins, and every extra coin is another lottery ticket on the
//     3% of coins that 5x. Fillers exit fast and never take a slot an ignition
//     entry could use (they only enter while < 4 positions are committed).
//   - Spray-and-let-ride: many small stakes, losers cut fast (-6% / stall / creator
//     sells / big dump), winners NEVER capped by a fixed second take-profit — the
//     rest rides a wide 40% trailing stop so the rare 5-10x runner is actually
//     captured (dev data: 7.3% of coins 3x from their 10th trade, 3% 5x). One shot
//     per coin, never re-entered.
//   - Buys ladder in (the harness caps each batch's buys at 1% of a mint's real SOL
//     reserve), so a position is built over several batches while the signal holds.
//
// Pure function of the batches it is fed: no clock, no environment, no Math.random.
// The only tie-break randomness is a deterministic hash of hello.seed + mint.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Age band (slots since first seen) for a first ignition buy. */
  ageMin: number;
  ageMax: number;
  /** Total trades on the coin allowed at ignition entry (early only). */
  maxTradesAtEntry: number;
  /** Trades counted for the ignition flow window. */
  flowTrades: number;
  /** Minimum buys among the flow window's trades. */
  minBuys: number;
  /** Minimum distinct buyers in the flow window. */
  minBuyers: number;
  /** Minimum net SOL flow (buys minus sells) over the flow window. */
  minNetFlowSol: number;
  /** Largest single sell allowed (fraction of real SOL reserve) — a dump vetoes entry. */
  maxBigSellFrac: number;
  /** Minimum trades in the last velocitySlots slots (regime: coin must be alive). */
  minVelocity: number;
  /** Velocity window (slots). */
  velocitySlots: number;
  /** Real SOL reserve band for a first ignition buy. */
  rqMinSol: number;
  rqMaxSol: number;
  /** Target stake per ignition coin (lamports). Built up over batches (1% of real reserve each). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for (lamports). */
  minBuyLamports: bigint;
  /** Max slots after the first buy decision during which adds may still be sent. */
  maxAddSlots: number;
  /** Stop adding if price runs this far above the first buy's decision price. */
  maxAddRunup: number;
  /** Max new ignition coins entered per batch. */
  maxNewPerBatch: number;
  /** First take-profit (fraction above entry): sell half. */
  tp1: number;
  /** Trailing stop arms once price is this far above entry (fraction). */
  trailArm: number;
  /** Trailing stop distance below the peak (fraction). Wide: lets runners breathe. */
  trail: number;
  /** Hard stop loss (fraction below entry). */
  stopLoss: number;
  /** Max hold (slots) before a time-stop exit. */
  maxHoldSlots: number;
  /** No trades for this many slots: the coin went quiet, exit. */
  staleSlots: number;
  // ---- filler tier (loose bar, token stake, fast exits) ----
  fillerStakeLamports: bigint;
  fillerFlowTrades: number;
  fillerMinBuys: number;
  fillerMinBuyers: number;
  fillerMinNetFlowSol: number;
  fillerAgeMax: number;
  fillerRqMinSol: number;
  fillerRqMaxSol: number;
  fillerMinVelocity: number;
  fillerTp: number;
  fillerStop: number;
  fillerMaxHoldSlots: number;
  fillerStaleSlots: number;
  /** Filler entries only while committed positions are below this count. */
  fillerMaxOpen: number;
  fillerMaxNewPerBatch: number;
  /** Hard cap on filler entries per run (bounds the tier's bleed). 0 = no cap. */
  fillerMaxTotal: number;
  /** Buy slippage allowance (bps). */
  buySlipBps: number;
  /** Sell slippage allowance (bps). */
  sellSlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  ageMin: 10,
  ageMax: 900,
  maxTradesAtEntry: 60,
  flowTrades: 10,
  minBuys: 7,
  minBuyers: 4,
  minNetFlowSol: 0.05,
  maxBigSellFrac: 0.2,
  minVelocity: 3,
  velocitySlots: 60,
  rqMinSol: 1,
  rqMaxSol: 30,
  stakeLamports: 30_000_000n,
  minBuyLamports: 5_000_000n,
  maxAddSlots: 300,
  maxAddRunup: 0.15,
  maxNewPerBatch: 3,
  tp1: 0.3,
  trailArm: 0.3,
  trail: 0.4,
  stopLoss: 0.06,
  maxHoldSlots: 1800,
  staleSlots: 300,
  fillerStakeLamports: 10_000_000n,
  fillerFlowTrades: 5,
  fillerMinBuys: 3,
  fillerMinBuyers: 2,
  fillerMinNetFlowSol: 0,
  fillerAgeMax: 3600,
  fillerRqMinSol: 0.5,
  fillerRqMaxSol: 50,
  fillerMinVelocity: 2,
  fillerTp: 0.1,
  fillerStop: 0.05,
  fillerMaxHoldSlots: 300,
  fillerStaleSlots: 180,
  fillerMaxOpen: 4,
  fillerMaxNewPerBatch: 2,
  fillerMaxTotal: 15,
  buySlipBps: 2000,
  sellSlipBps: 3000,
};

const SOL = 1_000_000_000;
const MASK64 = (1n << 64n) - 1n;

/** Deterministic 0..1 jitter from the run seed + mint (FNV-1a over the string). */
function seedJitter(seed: string, mint: string): number {
  let h = 0xcbf29ce484222325n;
  const s = `${seed}:${mint}`;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return Number(h % 1000n) / 1000;
}

interface Tick {
  slot: number;
  price: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  createdSlot: number;
  creator: string;
  ticks: Tick[];
  trades: number;
  complete: boolean;
  devSold: boolean;
  done: boolean; // exited (or vetoed for good): never enter again
  /** 0 = ignition tier, 1 = filler tier (set at entry). */
  tier: number;
  /** Entry price of the position currently being built/held (0 when flat). */
  entryPrice: number;
  entrySlot: number;
  peak: number;
  soldHalf: boolean;
  adding: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  let seed = '0';
  let fillerEntered = 0;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: -1,
        creator: '',
        ticks: [],
        trades: 0,
        complete: false,
        devSold: false,
        done: false,
        tier: 0,
        entryPrice: 0,
        entrySlot: -1,
        peak: 0,
        soldHalf: false,
        adding: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  const priceOf = (state: BotState, mint: Pubkey): number => {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  };

  /** Committed lamports on a mint: position cost + pending buy amounts. */
  const committedOf = (state: BotState, mint: Pubkey): bigint => {
    let total = 0n;
    const pos = state.positions.get(mint);
    if (pos !== undefined) total += pos.cost_lamports;
    for (const pend of state.pending.values()) {
      if (pend.order.mint === mint && pend.order.side === 'buy') {
        total += BigInt(pend.order.quote_lamports);
      }
    }
    return total;
  };

  /** Target stake for a tape's tier. */
  const targetStake = (t: Tape): bigint => (t.tier === 1 ? p.fillerStakeLamports : p.stakeLamports);

  return {
    onHello(state: BotState): void {
      seed = state.hello.seed;
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];
      const activeMints = new Set<Pubkey>();

      // ---- fold this batch's events into the tapes (hello, batch, orders, slot) ----
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createdSlot = e.slot;
          t.creator = e.creator;
          t.complete = false;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          if (t.createdSlot < 0) t.createdSlot = e.slot; // first seen via trade: coin predates this window
          if (t.creator === '') t.creator = e.creator;
          const vt = BigInt(e.virtual_token_reserves);
          const vq = BigInt(e.virtual_quote_reserves);
          const solAmt = Number(BigInt(e.sol_amount)) / SOL;
          if (vt > 0n) {
            t.ticks.push({
              slot: e.slot,
              price: Number(vq) / Number(vt),
              buy: e.is_buy,
              sol: solAmt,
              user: e.user,
            });
            if (t.ticks.length > 400) t.ticks.splice(0, t.ticks.length - 400);
          }
          t.trades++;
          // Creator selling, or one whale dumping, vetoes the coin for good.
          if (!e.is_buy && e.user === t.creator) t.devSold = true;
          if (!e.is_buy) {
            const curve = state.curves.get(e.mint);
            const rq = curve !== undefined ? Number(curve.real_quote_reserves) / SOL : 0;
            if (rq > 0 && solAmt > p.maxBigSellFrac * rq) t.done = true;
          }
          activeMints.add(e.mint);
        } else {
          const t = tapeOf(e.mint);
          t.complete = true;
          t.adding = false;
        }
      }
      // Prune ticks older than the velocity horizon (keeps memory bounded).
      const horizon = slot - p.velocitySlots - 50;
      for (const t of tapes.values()) {
        while (t.ticks.length > 0 && t.ticks[0].slot < horizon) t.ticks.shift();
      }

      // ---- reconcile exits with fills: only a FILLED sell closes (or partially
      // closes) a position. Resetting tape state when a sell is merely DECIDED
      // strands the position if that sell is rejected (it then rides to flatten).
      for (const f of batch.fills) {
        if (f.side !== 'sell' || f.status !== 'filled') continue;
        const t = tapes.get(f.mint);
        if (t === undefined) continue;
        if (!state.positions.has(f.mint)) {
          t.done = true; // one shot per coin: exited, never re-entered
          t.entryPrice = 0;
          t.entrySlot = -1;
          t.peak = 0;
          t.soldHalf = false;
          t.adding = false;
        } else {
          t.soldHalf = true; // a partial sell filled; the rest still rides
        }
      }
      // An entry whose buys never filled (all rejected) must not block re-entry.
      const reconcileMints = new Set<Pubkey>(activeMints);
      for (const mint of state.positions.keys()) reconcileMints.add(mint);
      for (const pend of state.pending.values()) reconcileMints.add(pend.order.mint);
      for (const mint of reconcileMints) {
        const t = tapes.get(mint);
        if (t === undefined || t.entryPrice === 0) continue;
        if (state.positions.has(mint)) continue;
        let pendingBuy = false;
        for (const pend of state.pending.values()) {
          if (pend.order.mint === mint && pend.order.side === 'buy') {
            pendingBuy = true;
            break;
          }
        }
        if (!pendingBuy && slot - t.entrySlot > 10) {
          t.entryPrice = 0;
          t.entrySlot = -1;
          t.peak = 0;
          t.soldHalf = false;
          t.adding = false;
        }
      }

      // ---- exits for held positions (tier-specific) ----
      for (const [mint, pos] of state.positions) {
        const t = tapes.get(mint);
        if (t === undefined) continue;
        const price = priceOf(state, mint);
        if (price <= 0 || t.entryPrice <= 0) continue;
        // Never stack a second sell while one is still in flight.
        let pendingSell = false;
        for (const pend of state.pending.values()) {
          if (pend.order.mint === mint && pend.order.side === 'sell') {
            pendingSell = true;
            break;
          }
        }
        if (pendingSell) continue;
        const ret = price / t.entryPrice - 1;
        if (price > t.peak) t.peak = price;
        const tokens = pos.token_amount;
        let sellTokens = 0n;
        const lastTickSlot = t.ticks.length > 0 ? t.ticks[t.ticks.length - 1].slot : t.entrySlot;
        if (t.devSold) {
          sellTokens = tokens; // creator dumped: get out now
        } else if (t.tier === 1) {
          // Filler: bank it all fast, cut it fast, free the slot.
          if (ret >= p.fillerTp || ret <= -p.fillerStop) sellTokens = tokens;
          else if (t.entrySlot >= 0 && slot - t.entrySlot >= p.fillerMaxHoldSlots) sellTokens = tokens;
          else if (slot - lastTickSlot >= p.fillerStaleSlots) sellTokens = tokens;
        } else if (!t.soldHalf && ret >= p.tp1) {
          sellTokens = tokens / 2n; // bank half; soldHalf flips when the fill is observed
        } else if (t.peak >= t.entryPrice * (1 + p.trailArm) && price <= t.peak * (1 - p.trail)) {
          sellTokens = tokens; // wide trailing stop: the only exit for runners
        } else if (ret <= -p.stopLoss) {
          sellTokens = tokens;
        } else if (t.entrySlot >= 0 && slot - t.entrySlot >= p.maxHoldSlots) {
          sellTokens = tokens;
        } else if (slot - lastTickSlot >= p.staleSlots) {
          sellTokens = tokens; // coin went quiet: exit instead of holding a dead curve
        }
        if (sellTokens > 0n) {
          orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: p.sellSlipBps });
          // Tape state is reset only when the fill is observed above.
        }
      }

      // ---- accumulation: keep building positions whose signal still holds ----
      let newEntries = 0;
      let newFillers = 0;
      const freeCash = (): bigint => state.freeCashLamports();

      interface Cand {
        mint: Pubkey;
        score: number;
        price: number;
        tier: number;
      }
      const ignition: Cand[] = [];
      const fillers: Cand[] = [];

      for (const mint of activeMints) {
        const t = tapes.get(mint);
        if (t === undefined || t.complete || t.done || t.devSold) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const price = priceOf(state, mint);
        if (price <= 0) continue;
        const held = state.positions.get(mint);
        const committed = committedOf(state, mint);

        // --- accumulation add for a coin already being built ---
        if (t.adding && committed < targetStake(t) && held !== undefined) {
          const cap = state.maxBuyLamports(mint);
          let amount = targetStake(t) - committed;
          if (amount > cap) amount = cap;
          const cash = freeCash() - state.txFeeLamports();
          if (amount > cash) amount = cash;
          if (amount >= p.minBuyLamports && orders.length < 14) {
            // Only add while the add window is open and price has not run away.
            if (slot - t.entrySlot <= p.maxAddSlots && price <= t.entryPrice * (1 + p.maxAddRunup)) {
              orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
            }
          }
          continue;
        }
        if (held !== undefined || committed > 0n) continue;
        if (t.entryPrice !== 0) continue; // mid-entry bookkeeping
        if (t.createdSlot < 0) continue;
        const age = slot - t.createdSlot;
        const rqSol = Number(curve.real_quote_reserves) / SOL;

        // --- ignition confirmation: the last flowTrades trades must show real demand ---
        if (age >= p.ageMin && age <= p.ageMax && t.trades <= p.maxTradesAtEntry && rqSol >= p.rqMinSol && rqSol <= p.rqMaxSol && t.ticks.length >= p.flowTrades) {
          const flow = t.ticks.slice(-p.flowTrades);
          let buys = 0;
          let netSol = 0;
          const buyers = new Set<string>();
          for (const tk of flow) {
            if (tk.buy) {
              buys++;
              netSol += tk.sol;
              buyers.add(tk.user);
            } else {
              netSol -= tk.sol;
            }
          }
          let velocity = 0;
          for (let i = t.ticks.length - 1; i >= 0; i--) {
            if (t.ticks[i].slot < slot - p.velocitySlots) break;
            velocity++;
          }
          if (buys >= p.minBuys && buyers.size >= p.minBuyers && netSol >= p.minNetFlowSol && velocity >= p.minVelocity) {
            const score =
              2 * Math.min(netSol, 5) / 5 +
              1.5 * (buys / flow.length - 0.5) +
              Math.min(buyers.size, 10) / 10 +
              Math.min(velocity, 20) / 20 +
              0.05 * seedJitter(seed, mint);
            ignition.push({ mint, score, price, tier: 0 });
            continue;
          }
        }

        // --- filler: the same shape on a looser bar, token stake ---
        if (age >= p.ageMin && age <= p.fillerAgeMax && rqSol >= p.fillerRqMinSol && rqSol <= p.fillerRqMaxSol && t.ticks.length >= p.fillerFlowTrades) {
          const flow = t.ticks.slice(-p.fillerFlowTrades);
          let buys = 0;
          let netSol = 0;
          const buyers = new Set<string>();
          for (const tk of flow) {
            if (tk.buy) {
              buys++;
              netSol += tk.sol;
              buyers.add(tk.user);
            } else {
              netSol -= tk.sol;
            }
          }
          let velocity = 0;
          for (let i = t.ticks.length - 1; i >= 0; i--) {
            if (t.ticks[i].slot < slot - p.velocitySlots) break;
            velocity++;
          }
          if (buys >= p.fillerMinBuys && buyers.size >= p.fillerMinBuyers && netSol >= p.fillerMinNetFlowSol && velocity >= p.fillerMinVelocity) {
            const score =
              2 * Math.min(netSol, 5) / 5 +
              1.5 * (buys / flow.length - 0.5) +
              Math.min(buyers.size, 10) / 10 +
              0.05 * seedJitter(seed, mint);
            fillers.push({ mint, score, price, tier: 1 });
          }
        }
      }

      // Rank candidates; enter ignitions first, then fillers on spare slots.
      const enter = (cands: Cand[], maxNew: number, tier: number): void => {
        cands.sort((a, b) => b.score - a.score);
        for (const cand of cands) {
          if (tier === 0 && newEntries >= maxNew) break;
          if (tier === 1 && newFillers >= maxNew) break;
          if (orders.length >= 14) break;
          if (tier === 1 && state.committedPositionCount() + newEntries + newFillers >= p.fillerMaxOpen) break;
          if (state.committedPositionCount() + newEntries + newFillers >= state.hello.caps.max_open_positions) break;
          const t = tapes.get(cand.mint)!;
          t.tier = tier;
          const stake = targetStake(t);
          const cap = state.maxBuyLamports(cand.mint);
          let amount = stake;
          if (amount > cap) amount = cap;
          const cash = freeCash() - state.txFeeLamports();
          if (amount > cash) amount = cash;
          if (amount < p.minBuyLamports) continue;
          orders.push({ side: 'buy', mint: cand.mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          t.entryPrice = cand.price;
          t.entrySlot = slot;
          t.peak = cand.price;
          t.soldHalf = false;
          t.adding = true;
          if (tier === 0) newEntries++;
          else {
            newFillers++;
            fillerEntered++;
          }
        }
      };
      enter(ignition, p.maxNewPerBatch, 0);
      if (p.fillerMaxTotal === 0 || fillerEntered < p.fillerMaxTotal) {
        enter(fillers, p.fillerMaxNewPerBatch, 1);
      }

      // A position whose accumulation finished (committed reached stake) stops adding.
      for (const [mint, pos] of state.positions) {
        const t = tapes.get(mint);
        if (t !== undefined && t.adding && committedOf(state, mint) >= targetStake(t)) t.adding = false;
      }

      return orders;
    },
  };
}
