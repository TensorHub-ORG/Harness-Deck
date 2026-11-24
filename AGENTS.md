# AGENTS.md — Harness-Deck Agent Router

> **Harness-Deck — 连接并驾驭。 / Connect and harness.**

Read the right document first depending on your task:

- **Developing, debugging, operating, or extending Harness-Deck (new session handoff)** → Read [`docs/A2A_HANDOFF.md`](docs/A2A_HANDOFF.md) first. It contains the full architecture, codebase map, non-negotiable security invariants, battle-tested Windows/`dsh`/`agy`/QQ pitfalls, and verification commands.
- **Helping a human user install & configure Harness-Deck from scratch (Day-0 onboarding)** → Read [`START_HERE.md`](START_HERE.md) and [`skills/deck-onboarding/SKILL.md`](skills/deck-onboarding/SKILL.md).

## Non-Negotiable Top-Level Rules

1. **Preserve Trust Tiers (`T0 > T1 > T2 > T3`)**: Never allow `T2 ↮ T3` direct messaging, never allow `T3 → T0` skip-level contact, and never bypass `L3` approval requirements.
2. **Keep Core Tool-Neutral**: Put tool-specific deep plugins under `adapters/` only; keep `protocol/`, `packages/`, `mcps/`, and `skills/` vendor-neutral.
3. **Zero Secrets in Git**: Never commit `.env`, `.deck/`, `*.sqlite*`, API keys, tokens, private SSH keys, VPS IPs, or personal QQ numbers. In tests, construct synthetic secret patterns dynamically so GitHub Secret Scanning never triggers.
4. **Always Verify After Code Changes**: Run `pnpm build`, `pnpm test`, `pnpm smoke:mcp`, and `pnpm deck doctor` before declaring work done.
5. **QQ Plain-Text Only**: Outgoing QQ messages must strip Markdown via `formatPlainTextForQq()`.
