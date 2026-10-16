# Changelog

## 0.4.0 — 2026-10-16 (demo release)

First release from the standalone `tannerconor55/turbo-kart` repository. A new
network: 0.4.0 does not race against v0.1–v0.3 (both DNA hashes changed). It
keeps its data in a new directory, so an earlier demo install is left untouched.

### Added
- Championship cups: Cove, Adventure, Speed and Skill Cup (three courses each,
  15-12-10-8-6-4-2-1 points), solo and multiplayer. Twelve courses for single races.
  The `turbo_kart` DNA accepts the new course and cup IDs.
- "N other players online" on the multiplayer screen. Each running app marks itself
  online every 60 s; the count covers the last 2–4 minutes and is approximate.
- Host AI karts travel as one bundle per tick (lane 8), and kart/AI deliveries carry
  a sidecar arrival stamp for playout timing.

### Changed
- Online kart state is sent at 30 Hz (was 20 Hz), with render blending, a playout
  clock and smoothing of remote karts. See `E6-NETCODE-SMOOTHING.md`.
- Package metadata now points to this repository.

### Known limitations
- Windows builds are single-player only (no realtime connection yet).
- Internet mode relays through `dev-test-bootstrap2.holochain.org`, a Holochain
  dev/test service with no uptime guarantee.
- Collisions between online karts can feel uneven; items are off online; one race
  (or cup) per lobby.
- Players in a race drop out of the online count after a few minutes.

## Earlier demos

- **v0.3 "Internet Stability"** (package 0.1.2) — `DEMO-BUILD-MANIFEST-v0.3.md`
- **v0.2 Internet test** (package 0.1.1) — `DEMO-BUILD-MANIFEST-v0.2.md`
- **v0.1 LAN demo** (package 0.1.0) — `DEMO-BUILD-MANIFEST.md`
