---
name: refinery-merge
description: Deterministic branch integration, conflict resolution, and green-trunk verification protocol
roles: [integrator]
tier: static
---
Follow this merge protocol strictly:
1. Inspect every completed branch diff before merging (`git diff --stat <base>..<branch>`).
2. Merge one branch at a time; never drop or overwrite another ticket's tested changes when resolving conflicts.
3. Run the full test/verification command after integrating all branches — fix any cross-module interface mismatch.
4. Only call `report_finding` and `nominate` after verification passes cleanly on the integrated tree.
