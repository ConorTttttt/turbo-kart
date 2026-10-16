# E6 netcode smoothing: 30 Hz, render blending, playout clock, collisions, stamps, AI bundles, auto quality

Follows [E6-INTERNET-1-STABILITY.md](E6-INTERNET-1-STABILITY.md) (J1–J8, S1–S3). Status:
unit- and crate-tested on one machine. **Not yet run in the desktop app or across real
networks** (see Known limitations).

## 1. What changed

| Item | Where | What |
|---|---|---|
| Send rate | game `netplay.js` | `SEND_HZ` 20 → **30** (must divide the 60 Hz sim so snapshots are evenly spaced). Harness bands in `scripts/e63-test.mjs` / `e64-test.mjs` moved to 26–34 Hz (AI ≥ 150/s published, ≥ 120/s received) |
| S1 render blending | game `main.js` | Online, each frame draws every kart at `lerp(prevStep, currStep, acc / step)` (heading the short way); camera, HUD, audio and render see the blend, then the step pose is restored. Physics, snapshots, progress and collisions only see step poses. A > 10 m step (respawn) is not blended. Single-player unchanged |
| S2 playout clock | game `netplay.js` `SnapshotBuffer` | Offset = min transit over 2 s of sender time, raised early if the last 0.5 s are all slower (path got slower). Delay = 100 ms, grown by measured lateness (2 intervals + mean + 3σ), ≤ 250 ms. The applied lag slews at ≤ 2 % (catch up) / 4 % (fall back) of real time; only > 150 ms errors resync. `onOffset` now reports resyncs only |
| Hermite | same | Cubic Hermite through both snapshots' positions and velocities; linear when they disagree (respawn, wall hit) |
| S3 correction smoothing | game `netplay.js` `PoseSmoother` | A per-step jump off the pose's own velocity (> 0.1 m / 0.15 rad) is absorbed into an error offset that decays ×0.95/step (≤ 25 cm) to ×0.85/step (≥ 1 m); > 10 m is shown at once. Held poses count as stationary |
| Cross-machine collisions | game `netplay.js` `predict`/`nearPresent`, `main.js` `netProxies` | Each machine stays authoritative for the karts it simulates. Remote karts join its collision pass as proxies at their **predicted present** (newest sample carried forward by `now − offset + RTT/2`, ≤ 250 ms, turning at the last observed yaw rate). The pass is mass-weighted and symmetric, so each side applies its own kart's share; no message is sent. A remote kart within 8 m of yours is drawn at that predicted pose (blending back to interpolated by 20 m), so bumps happen where you see it |
| Sidecar arrival stamps | sidecar `binary.rs`, `realtime.rs`, `racectl.rs`; game `netplay.js` `SidecarClock` | Kart (lane 4) and AI (lane 5) **deliveries** end with an 8-byte stamp (§2). The renderer maps it to its clock with the minimum (page receipt − stamp) over 10 s, so arrivals no longer include main-process / event-loop / frame delays (J2) |
| AI bundles | host crate `wire.rs`, `session.rs`; sidecar; main `binary.ts`; game | The host sends one tick of every AI slot as one `AiBundle` (§2): one datagram per peer per tick instead of six, and one renderer → sidecar message instead of six. Receivers split it into the same per-slot `AiSnapshot`s, under the same epoch classification as `AiFrame` |
| Auto graphics quality | game `quality.js`, `main.js`, `environment.js` | Tiers high → medium → low → lowest (pixel-ratio cap 2 / 1.5 / 1 / 0.75; bloom off from low; sun shadow map 2048 → 1024 from low). Steps down when > 20 % of a 2 s window's frames exceed 1.5 × max(16.7 ms, display refresh); steps up after 10 clean seconds; a relapse within 15 s blocks that tier for 2 min (doubling, ≤ 10 min). `localStorage['tkr-quality']` = `auto` (default) or a tier name. Shadow texel snapping follows the current map size. `window.__game.quality` shows the state |

## 2. Wire changes

All three are additive. Old constants, lanes and messages keep their meaning.

**Binary lane 8 `AI_BUNDLE_LANE` (renderer → main → sidecar, send only).** Payload
`n × (slot u8 | 42-byte WP3 KartState)`, `1 ≤ n ≤ 7`, `member` = 0. Main checks the
shape. Rust checks the sender is the admission's host, every slot is on the grid
and appears once, and every state decodes. A delivery on lane 8 is refused: peers
still get one lane-5 delivery per slot.

**Delivery stamp (sidecar → renderer, lanes 4 and 5, operation 3 only).** Payload =
`KartState (42) | arrival_us u64 BE`: microseconds on the sidecar's monotonic clock
since process start, taken when the object came off the network (kart: at
`recv_object`; AI: when the forwarder takes it from the host session). Sends are
unchanged (exactly 42 bytes). The renderer also accepts unstamped 42-byte
deliveries (then arrival = page receipt).

**Host wire type 4 `AiBundle`** on Latest track `race/<r>/ai-<lowest slot>/bundle`:

```text
0 version=1 | 1 type=4 | 2 epoch u32 | 6 count u8 (1..=8)
| count × (slot u8 | len u16 | payload)      slots distinct; whole message ≤ 1024 B
```

Six 42-byte AI states make one 277-byte message. Golden bytes and rejections:
`crates/host/tests/wire.rs`.

**Compatibility.** Every player in a race must run this build. A host on this
build sends only bundles, so a peer on an older build sees frozen AI. The other
direction works: this build still subscribes to per-slot AI tracks. The renderer
and sidecar ship in one app, so their versions always match.

## 3. Tests

| Suite | Result |
|---|---|
| Game `tests/*.test.mjs` (Node 24, `--test-isolation=none`) | all pass: netplay 36/36, quality 6/6, netcollide 2/2, progress 8/8, lobby 12/12, content 4/4, weapons 19/19 |
| `cargo test -p holochain-moq-host` | all pass, incl. new `tests/bundle.rs` (3, real iroh meshes: delivery as per-slot snapshots, host-only/slot checks, refusal of epoch-1 bundles after a host change) and the `AiBundle` wire test |
| `cargo test -p turbo-kart-sidecar` | 47 + 3 + 11 pass (2 ignored as before), incl. lane-8 parsing, stamp format, stamped kart/AI deliveries and a bundle round-trip between two sessions |
| Desktop `tests/*.test.ts` (tsx from the old holochain-moq app's `node_modules`) | 46 pass, 2 skipped (as before), incl. lane-8 validation |

Notable checks:
- `netcollide.test.mjs`: with correct predictions, two machines each resolving their own kart against a proxy end up with **exactly** (1e-9) the positions and velocities one machine computes with both karts local.
- `netplay.test.mjs` S2: a 40 ms faster path is adopted with no per-step jump above 1.02 m at 60 m/s and no resync. A +80 ms slower path causes no holds. Jitter grows the delay, and a clean path keeps 100 ms.
- A seeded simulation (curve, 60 Hz receiver) compared the old and new pipelines. The largest per-step pose jump: clean 0.03 → 0.01 m; 40 ms jitter / 3 % loss 0.29 → 0.02 m; 80 ms / 5 % 0.43 → 0.02 m with holds 2 → 0; a +80 ms path change 2.69 m → 0.03 m. The cost is a longer playout lag on jittery paths (131 → 154 ms, 132 → 233 ms). This is a model, not a network run.

## 4. Known limitations

- **No desktop or real-network run yet.** The game UI must be rebuilt into the app. Then run the E6.3 / E6.4 / E6.5a desktop tests, a `scripts/netem-run.sh` run with 30–80 ms jitter, and an owner check with two machines. The `[tk-diag]` lines show steps per frame, holds, resyncs (`offset_steps`) and jumps; `jumps` now measures the drawn (smoothed) pose.
- **Collisions depend on prediction.** When the two machines predict differently (sharp input changes within the ~RTT/2 + playout window), each applies its share of a slightly different collision. Bumps can then feel uneven, or happen on one side only. Exactly coincident karts (< 0.1 mm apart) take the resolver's index-based normal, which is not symmetric across machines. Items are still off online.
- **Nearby karts are drawn predicted.** Within 8 m they can overshoot on a sudden turn or brake, corrected through S3 smoothing.
- **Mixed builds.** An older peer gets no AI from a host on this build (§2).
- **Auto quality** applies in single-player too, and has not been visually checked. Changing the shadow map size reallocates it, which can cause one hitch per change. Tiers change at most once per 2 s window.
- Stamps assume the sidecar and the page share a monotonic clock source (same machine, CLOCK_MONOTONIC / QPC). The 10 s minimum also absorbs a clock step.
