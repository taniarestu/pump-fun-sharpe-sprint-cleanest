[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/taniarestu/pump-fun-sharpe-sprint-cleanest/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/taniarestu/pump-fun-sharpe-sprint-cleanest/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Pump.fun Sharpe Sprint — Cleanest Paper Bot

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
bounty (`u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532`): one strategy program,
`main.ts` on Node 22, trading paper SOL on a 6-hour pump.fun replay. Places go by
hourly Sharpe ratio, so the bot aims for steady, controlled gains, not one lucky
moonshot.

## Strategy

A fresh pump.fun coin bursts in the slot it is created, then fades for minutes.
Buying the burst is buying the top, so this bot only buys a coin that is *still*
pumping after the burst:

- price at least **1.5x** its creation price, and at least **1.2x** where it stood
  350 slots (~75 s) ago, with a fresh reference sample;
- real SOL reserve at least **1 SOL**, so the 1% size cap covers the stake;
- coin younger than **2,800 slots** (~10 min);
- fixed stake of **0.01 SOL** per coin (the smallest stake that counts as a round
  trip), at most **5** open positions, one buy per mint.

Exits are fast, which keeps the hourly equity curve smooth:

- take profit at **+8%** of cost;
- trailing stop once **+4%** up, exiting at **−4%** from the peak;
- hard stop at **−4%** of cost;
- time stop after **150 slots** (~30 s).

All decisions use exact `BigInt` arithmetic on the reserves the harness reports:
no floats, no clock, no randomness, no network. Two runs on the same data decide
the same orders.

## Files

- `main.ts` — the strategy (the entrypoint, run by the grader as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` bot shim, copied
  byte-identical from the competition kit (`sdk/ts/makefun-bot.ts`).

## Local grading

With the competition kit unpacked next to this repository:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Parameters

The constants in `main.ts` were swept on the kit's 24-hour dev window (1,222
coins). The chosen set (1.5x creation, 1.2x recent, +8% / −4% / 150-slot exits)
was the best of the sweep on both net PnL and hourly Sharpe while keeping
round trips safely above the 20-coin guardrail (~30 per 6 hours on the dev data).

## License

MIT — see [LICENSE](LICENSE).
