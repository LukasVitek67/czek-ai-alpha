---
name: czek-performance
description: Use when something is slow, uses too much memory, or the user asks to optimize or speed up. Measure first, find the real bottleneck, change one thing, measure again - no speed claims without numbers.
---

# Performance

1. **Measure the baseline** with a repeatable command (time a script, benchmark, profiler, browser devtools). Write the number down.
2. **Find the bottleneck** before changing anything: profile, add timers around phases, count calls/queries. Most time is usually in one place (N+1 queries, repeated work in a loop, synchronous I/O, re-rendering, huge payloads).
3. **Fix the biggest one only**: cache repeated work, batch requests, use the right data structure (Set/Map instead of array search), stream instead of loading all, debounce UI events.
4. **Measure again** under the same conditions; run at least 2–3 times. Report before → after with numbers.
5. **Keep correctness**: run tests after the change; a fast wrong answer is a bug.
- Do not micro-optimize code that is not hot. Readability wins when the gain is unmeasurable.
