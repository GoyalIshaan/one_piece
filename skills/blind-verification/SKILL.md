---
name: blind-verification
description: Adversarial edge-case verification and counterexample testing protocol for reviewers
roles: [reviewer]
tier: static
---
Verify claims adversarially — never trust the author's summary alone:
1. Read the actual modified files and run independent checks/tests in your read-only scratch environment.
2. Probe boundary conditions: empty inputs, degenerate sizes, non-ASCII/special characters, concurrency, and error paths.
3. If any claim fails or lacks evidence, return a concrete minimal counterexample with exact command output.
