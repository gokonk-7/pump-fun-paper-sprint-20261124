// Pullback-Ride entrypoint: the grader runs `node main.ts` (Node 22 strips types).
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
