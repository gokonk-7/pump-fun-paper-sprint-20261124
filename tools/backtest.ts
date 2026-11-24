// Local backtest runner (NOT part of the entry; the grader never runs this).
// Loads all three dev dataset parts, splits them into ~6h windows by slot, and replays
// the strategy through the kit's sim port (tools/sim.ts) on each window, so parameters
// are judged across MULTIPLE windows instead of the single frozen dev window.
// Usage: node tools/backtest.ts [windowIndex|all]  (default: all windows + part-00000 dev)

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { simulate, makeHello, phaseSeed, type Dataset } from './sim.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';

const KIT = new URL('../kit/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-kit/', import.meta.url).pathname;
const SOL = 1_000_000_000n;

export function loadAllEvents(): any[] {
  const manifest = JSON.parse(readFileSync(`${KIT}dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  for (const part of ['part-00000', 'part-00001', 'part-00002']) {
    const raw = gunzipSync(readFileSync(`${KIT}dataset/events/${part}.ndjson.gz`)).toString('utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) {
          members.add(e.mint);
        }
      }
      if (members.has(e.mint)) events.push(e);
    }
  }
  return events;
}

export function toDataset(events: any[], endSlot: number, sha: string): Dataset {
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  return { sha256: sha, events, endSlot, batches };
}

const fmtSol = (lamports: bigint): string => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;

export function runWindows(params: Params, label: string): { window: number; pnl: bigint; mints: number; fills: number; maxDd: number }[] {
  const events = loadAllEvents();
  const kitJson = JSON.parse(readFileSync(`${KIT}kit.json`, 'utf8'));
  const firstSlot = events[0].slot;
  const lastSlot = events[events.length - 1].slot;
  const span = lastSlot - firstSlot;
  const nWindows = 7;
  const wSize = Math.floor(span / nWindows);
  console.log(`\n== ${label} ==`);
  console.log(`events=${events.length} slots ${firstSlot}..${lastSlot} span=${span} (~${(span * 0.4 / 3600).toFixed(1)}h), ${nWindows} windows of ${wSize} slots (~${(wSize * 0.4 / 3600).toFixed(2)}h)`);
  const results = [];
  for (let w = 0; w < nWindows; w++) {
    const start = firstSlot + w * wSize;
    const end = w === nWindows - 1 ? lastSlot : firstSlot + (w + 1) * wSize;
    const we = events.filter((e) => e.slot >= start && e.slot < end);
    if (we.length === 0) continue;
    const ds = toDataset(we, end, kitJson.dataset_sha256);
    const hello = makeHello(phaseSeed('u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b', `w${w}`, kitJson.dataset_sha256));
    const t0 = Date.now();
    const res = simulate(ds, hello, createStrategy(params));
    const top = [...res.perMint.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 3);
    const topSum = top.reduce((s, [, v]) => s + v, 0n);
    console.log(
      `w${w} slots ${start}..${end} events=${we.length} pnl=${fmtSol(res.netPnl)} fills=${res.fills} coins=${res.mints} ` +
        `maxDD=${(res.maxDrawdown * 100).toFixed(1)}% rejected=${res.rejected} failed=${res.failed} ` +
        `top3=${fmtSol(topSum)} (${res.netPnl !== 0n ? ((Number(topSum) / Number(res.netPnl)) * 100).toFixed(0) : '0'}%) ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    results.push({ window: w, pnl: res.netPnl, mints: res.mints, fills: res.fills, maxDd: res.maxDrawdown });
  }
  const pnls = results.map((r) => r.pnl).sort((a, b) => (a < b ? -1 : 1));
  const median = pnls[Math.floor(pnls.length / 2)];
  const total = pnls.reduce((s, v) => s + v, 0n);
  const minCoins = Math.min(...results.map((r) => r.mints));
  console.log(`SUMMARY ${label}: median=${fmtSol(median)} total=${fmtSol(total)} worst=${fmtSol(pnls[0])} best=${fmtSol(pnls[pnls.length - 1])} minCoins/window=${minCoins} wins=${pnls.filter((v) => v > 0n).length}/${pnls.length}`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2] ?? 'all';
  if (arg === 'all') runWindows(DEFAULT_PARAMS, 'DEFAULT_PARAMS');
  else {
    const w = Number(arg);
    const events = loadAllEvents();
    const kitJson = JSON.parse(readFileSync(`${KIT}kit.json`, 'utf8'));
    const firstSlot = events[0].slot;
    const lastSlot = events[events.length - 1].slot;
    const span = lastSlot - firstSlot;
    const wSize = Math.floor(span / 7);
    const start = firstSlot + w * wSize;
    const end = w === 6 ? lastSlot : firstSlot + (w + 1) * wSize;
    const we = events.filter((e) => e.slot >= start && e.slot < end);
    const ds = toDataset(we, end, kitJson.dataset_sha256);
    const hello = makeHello(phaseSeed('u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b', `w${w}`, kitJson.dataset_sha256));
    const res = simulate(ds, hello, createStrategy(DEFAULT_PARAMS));
    console.log(`w${w} pnl=${fmtSol(res.netPnl)} fills=${res.fills} coins=${res.mints} maxDD=${(res.maxDrawdown * 100).toFixed(1)}%`);
  }
}
