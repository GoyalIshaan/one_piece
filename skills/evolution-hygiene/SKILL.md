---
name: evolution-hygiene
description: Single-hypothesis mutation discipline, exact measurement, and negative-memory tracking
roles: [worker]
tier: on-demand
---
Apply disciplined evolutionary search:
1. Change ONE clearly testable algorithmic or implementation hypothesis per generation.
2. Verify correctness before measuring score; never sacrifice exactness or spec compliance for speed.
3. Check the failed-ideas list first — do not repeat a previously rejected mutation verbatim.
4. Always report the exact numeric `score` and concise hypothesis summary in `report_finding`.
