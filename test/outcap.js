'use strict';
// Test: proxy rozpozná strop odpovědi z chybové hlášky providera a nezabije
// long outputs fallbackem na 4 096. Testuje parser hlášek + limit MAX_OUT/DEFAULT_OUT.
const { outCapFromError, outLimitFromQuota, outCapOf, outFor, capRetry, hardCaps, quotaCaps, MAX_OUT, DEFAULT_OUT } = require('../src/proxy');

let fails = 0;
const eq = (got, want, what) => {
  if (got !== want) { fails++; console.log(`FAIL ${what}: got ${got}, want ${want}`); }
};

// Hlášky ověřené měřením (docs/research/loop-czek-perf/results/outcap-2026-11-21.json)
eq(outCapFromError('max_tokens must be at most 65536'), 65536, 'groq "at most"');
eq(outCapFromError('max_tokens must be less than or equal to 8192, the maximum value for max_tokens is less than the context_window for this model'), 8192, 'groq cap 8192');
eq(outCapFromError('maximum tokens is 16384'), 16384, 'generic maximum tokens');
eq(outCapFromError('max_tokens is too large: no more than 4096'), 4096, 'no more than');
// Kontextová hláška NENÍ strop odpovědi – nesmí se zaměnit
eq(outCapFromError('This model has a maximum context window size of 8192 tokens'), 0, 'context window, not output cap');
eq(outCapFromError('Prompt exceeds maximum context length of 32768 tokens'), 0, 'context length');
eq(outCapFromError('input is too long for this model'), 0, 'input too long');
eq(outCapFromError('rate limit exceeded'), 0, 'no cap in message');
eq(outCapFromError('max_tokens of 200000 exceeds context length 32000'), 200000, 'both mentioned: takes max_tokens number');

eq(MAX_OUT, 32768, 'MAX_OUT raised from 16384');
eq(DEFAULT_OUT, 16384, 'DEFAULT_OUT when client sends no max_tokens');

// OTPM: provider says how much of the minute quota is left – proxy must not cool the model down
eq(outLimitFromQuota('Request too large for model `qwen/qwen3.8-27b` in this minute, based on output tokens per minute (OTPM): Limit 1000, Used 900, Requested 1329. The request\'s expected output tokens exceed the enforced limit; reduce max_tokens'), 100, 'groq OTPM remaining');
eq(outLimitFromQuota('based on output tokens per minute (OTPM): Limit 8000, Used 7904, Requested 209'), 96, 'groq OTPM remaining 2');
eq(outLimitFromQuota('Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Requested 1329. Please try again in 19.8s.'), 1000, 'groq OTPM without Used = whole minute budget');
eq(outLimitFromQuota('Rate limit reached for requests'), null, 'plain rate limit is not an OTPM quota');
eq(outLimitFromQuota('max_tokens must be at most 65536'), null, 'hard cap is not an OTPM quota');

// Learned caps: fresh cap counts, expired cap does not, hard cap and quota cap take the minimum
const ADAPT = process.env.ZDARMA_ADAPT_OUT !== '0';
const now = Date.now();
if (ADAPT) {
  hardCaps.set('mock/cap8192', { cap: 8192, until: now + 60_000 });
  eq(outCapOf('mock/cap8192'), 8192, 'fresh hard cap below DEFAULT_OUT is used');
  hardCaps.set('mock/stale', { cap: 4096, until: now - 1 });
  eq(outCapOf('mock/stale'), 0, 'expired hard cap is forgotten (TTL)');
  quotaCaps.set('mock/cap8192', { cap: 1000, until: now + 30_000 });
  eq(outCapOf('mock/cap8192'), 1000, 'quota cap tighter than hard cap wins');
  quotaCaps.set('mock/cap8192', { cap: 20000, until: now + 30_000 });
  eq(outCapOf('mock/cap8192'), 8192, 'looser quota cap does not overwrite the hard cap');
  eq(outCapOf('mock/never-tried'), 0, 'unknown model has no cap');
} else {
  hardCaps.set('mock/cap8192', { cap: 8192, until: now + 60_000 });
  eq(outCapOf('mock/cap8192'), 0, 'ZDARMA_ADAPT_OUT=0 disables learned caps');
}

// Clamp on the OmniRoute combo path: OpenCode asks 16 000 for every tier combo, but the
// models inside hard-cap at 8 192 and OmniRoute does not check its own stored limit.
if (ADAPT) {
  const combo = 'zdarma-max';
  hardCaps.set(combo, { cap: 8192, until: now + 60_000 });
  eq(outFor(combo, 16000), 8192, 'combo clamped to the learned cap');
  eq(outFor('never-tried-combo', 16000), 16000, 'unknown combo keeps the client request');
  eq(outFor(combo, 4000), 4000, 'client asking less than the cap is not inflated');
  eq(outFor(combo, 0), 8192, 'no max_tokens from client → DEFAULT_OUT, then the cap');
  eq(outFor(combo, 100000), 8192, 'absurd request clamped to MAX_OUT, then to the cap');
  eq(capRetry('`max_tokens` must be less than or equal to `8192`', 16000, 0), 8192, 'learn cap → retry with less');
  eq(capRetry('`max_tokens` must be less than or equal to `8192`', 8192, 0), 0, 'no retry when we already send less');
  eq(capRetry('`max_tokens` must be less than or equal to `8192`', 16000, 2), 0, 'retrying stops after 2 attempts');
  eq(capRetry('rate limit reached for requests', 16000, 0), 0, 'no cap in the message → no retry');
  eq(capRetry('on output tokens per minute (OTPM): Limit 8000, Used 0, Requested 16000', 16000, 0), 8000, 'remaining quota counts as a cap');
  eq(capRetry('on output tokens per minute (OTPM): Limit 1000, Used 900, Requested 1329', 16000, 0), 0, 'quota left under 512 tokens is not worth retrying');
}

console.log(fails ? `outcap FAILED (${fails})` : `outcap OK (13 hlášek, 2 limity, ${ADAPT ? 'adaptivní stropy zapnuty' : 'adaptivní stropy vypnuty'}, clamp combo + retry 2×)`);
process.exit(fails ? 1 : 0);
