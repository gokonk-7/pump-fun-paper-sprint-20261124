# pump-fun-paper-sprint-20261124

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/gokonk-7/pump-fun-paper-sprint-20261124/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/gokonk-7/pump-fun-paper-sprint-20261124/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Free entry, five minutes of work: this bot paper-trades pump.fun on a 6-hour replay, highest net PnL takes the pot. Any strategy counts - even buy-and-hold.

## Strategy: Ignition Spray

Two tiers, one idea — breadth plus skew, not picking the perfect entry:

- **Ignitions (0.03 SOL):** young coins (10–900 slots) whose first trades *confirm* real demand — mostly buys, several distinct buyers, positive net SOL flow, no big dump yet, creator still holding. Losers are cut fast (−6% / stall / creator sells); winners are never capped by a fixed take-profit — half banks at +30%, the rest rides a wide 40% trailing stop so the rare 5–10× runner is actually captured.
- **Fillers (0.01 SOL, max 15/run):** the same shape on a looser bar. They exist because the ignition filter alone only finds ~18–19 coins per 6-hour window while the guardrail demands 20 distinct round-tripped coins — and every extra coin is another lottery ticket on the ~3% of coins that 5×.

Buys ladder in over several batches (the harness caps each batch's buys at 1% of a mint's real SOL reserve). Pure function of the batches it is fed: no clock, no environment, no randomness — the only tie-break is a deterministic hash of the run seed + mint.

Local backtests (kit sim port, 7 × ~6.4 h windows of the dev dataset): median −0.035 SOL/window, best window +0.010 SOL (driven by a captured runner), max drawdown ≤ 0.9%, 25–43 coins per window. Dev data is brutal — every published strategy loses on it — so this bot is built to lose the least while keeping a live ticket on the upside.

## Run it

```sh
node main.ts
```

Node 22+ runs the TypeScript directly (type stripping, no build step). The harness speaks `agent-fun/replay/v2` on stdin/stdout via `vendor/makefun-bot.ts`. Local backtests live in `tools/` (`node tools/backtest.ts all`, `node tools/sweep.ts`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=sqj6a0rx&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
