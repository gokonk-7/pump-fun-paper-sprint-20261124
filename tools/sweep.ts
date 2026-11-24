// Parameter sweep across MULTIPLE historical windows (never tune to one window).
// Loads the dev dataset once, replays each param combo on 7 x ~6.4h windows via the
// kit sim port, and ranks combos by median window PnL, then worst window.
// Usage: node tools/sweep.ts

import { readFileSync } from 'node:fs';
import { simulate, makeHello, phaseSeed } from './sim.ts';
import { loadAllEvents, toDataset } from './backtest.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';

const KIT = new URL('../kit/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-kit/', import.meta.url).pathname;
const kitJson = JSON.parse(readFileSync(`${KIT}kit.json`, 'utf8'));
const COMP = 'u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b';
const SOL = 1e9;

const events = loadAllEvents();
const firstSlot = events[0].slot;
const lastSlot = events[events.length - 1].slot;
const span = lastSlot - firstSlot;
const N_W = 7;
const wSize = Math.floor(span / N_W);
const windows: { events: any[]; end: number }[] = [];
for (let w = 0; w < N_W; w++) {
  const start = firstSlot + w * wSize;
  const end = w === N_W - 1 ? lastSlot : firstSlot + (w + 1) * wSize;
  windows.push({ events: events.filter((e) => e.slot >= start && e.slot < end), end });
}

function evalParams(params: Params): { median: number; worst: number; total: number; wins: number; minCoins: number } {
  const pnls: number[] = [];
  let minCoins = Infinity;
  for (let w = 0; w < N_W; w++) {
    const ds = toDataset(windows[w].events, windows[w].end, kitJson.dataset_sha256);
    const hello = makeHello(phaseSeed(COMP, `w${w}`, kitJson.dataset_sha256));
    const res = simulate(ds, hello, createStrategy(params));
    pnls.push(Number(res.netPnl) / SOL);
    if (res.mints < minCoins) minCoins = res.mints;
  }
  const sorted = [...pnls].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    worst: sorted[0],
    total: pnls.reduce((s, v) => s + v, 0),
    wins: pnls.filter((v) => v > 0).length,
    minCoins,
  };
}

const combos: { name: string; params: Params }[] = [];
for (const stakeSol of [0.05, 0.08, 0.12]) {
  for (const tp1 of [0.15, 0.2, 0.3]) {
    for (const stopLoss of [0.06, 0.08, 0.12]) {
      const params: Params = {
        ...DEFAULT_PARAMS,
        tp1,
        stopLoss,
        stakeLamports: BigInt(Math.round(stakeSol * SOL)),
      };
      combos.push({
        name: `stake=${stakeSol} tp1=${tp1} sl=${stopLoss}`,
        params,
      });
    }
  }
}

console.log(`sweeping ${combos.length} combos x ${N_W} windows`);
const rows: { name: string; median: number; worst: number; total: number; wins: number; minCoins: number }[] = [];
for (const c of combos) {
  const r = evalParams(c.params);
  rows.push({ name: c.name, ...r });
  console.log(`${c.name} -> median=${r.median.toFixed(3)} worst=${r.worst.toFixed(3)} total=${r.total.toFixed(3)} wins=${r.wins}/7 minCoins=${r.minCoins}`);
}
rows.sort((a, b) => b.median - a.median || b.worst - a.worst);
console.log('\nTOP 8 by median:');
for (const r of rows.slice(0, 8)) {
  console.log(`median=${r.median.toFixed(3)} worst=${r.worst.toFixed(3)} total=${r.total.toFixed(3)} wins=${r.wins}/7 minCoins=${r.minCoins} | ${r.name}`);
}
