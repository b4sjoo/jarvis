# Architecture Contracts

This directory contains tracked, privacy-safe engineering contracts. No file in
this directory may contain transcripts, screenshots, memory content, local
absolute paths, provider secrets, or session-recording payloads.

## Files

- `deletion-ledger.schema.json` defines the deletion-governance record.
- `deletion-ledger.json` maps each planned breaking removal to its replacement,
  persistence impact, proof commands, deletion gate, and rollback boundary.
- `architecture-contract.json` records current authority locations, known
  dependency cycles, broad-barrel consumers, Tauri IPC/events, and explained
  cross-side exceptions.
- `orchestration-replay-baseline.json` pins the canonical digest for a real
  generation-lease replay where a newer result commits before a stale result.
- `verification-budget.json` records measured gate durations and the 20 percent
  investigation thresholds used by the full verifier.

## Commands

```bash
npm run verify:deletion-ledger
npm run verify:architecture
npm run verify:next-major
```

`verify:architecture` is the fast local gate. `verify:next-major` runs every
gate in order and writes `.tmp-architecture/next-major-verification-report.json`.
The report records the current commit, dirty-file count, command, duration, gate
status, and budget comparison without recording file contents.

## Updating A Baseline

Do not regenerate a contract merely to make a failure disappear.

1. Confirm the code change is intentional and covered by its task brief.
2. Prefer reducing writers, cycles, barrel consumers, and IPC exceptions.
3. Run the focused tests that prove the replacement boundary.
4. For an intentional architecture-contract change, run
   `node scripts/verify-architecture.mjs --write-baseline --force-baseline`.
5. Review every generated IPC exception reason; replace generic text with a
   concrete owner and rationale before commit.
6. Run `npm run verify:next-major` and inspect the generated report.

Removing a stale exception or lowering a ceiling is expected. Raising a ceiling
requires explicit review.
