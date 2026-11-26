---
name: debugging-bisect
description: Minimal reproduction, root-cause isolation, and regression testing for elusive bugs
tier: on-demand
---
When debugging a failing test or unexpected regression:
1. Reproduce the failure with the smallest possible command or unit test first.
2. Isolate the exact failing invariant (print/assert inputs and intermediate state rather than guessing).
3. Fix the root cause cleanly, then keep a regression test verifying the failure no longer reproduces.
