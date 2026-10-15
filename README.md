# Turbo Kart

Turbo Kart Rally desktop multiplayer, built on Holochain.

Split out of [holochain-moq](https://github.com/tannerconor55/holochain-moq)
(branch `feat/wp1-wp2`, commit `d743f37`) as a snapshot copy, without history.

| Path | What |
|---|---|
| `apps/turbo-kart-desktop/` | Electron desktop app, kart-net sidecar, frozen Tauri shell, test harnesses. See its [README](apps/turbo-kart-desktop/README.md). |
| `dna/` | The `gaming_directory` and `turbo_kart` DNAs (separate wasm32 Cargo workspace). |
| `crates/` | The holochain-moq crates the app and DNAs depend on, copied as-is. |

The web game itself is expected next to this repo at `../turbo-kart-rally-main`
(override with `TURBO_KART_GAME_DIR`).

Release binaries (`.deb`, `.zip`, `.webhapp`) are not in git; they are attached to
[GitHub Releases](https://github.com/tannerconor55/turbo-kart/releases).

Note: the zome wasm embeds the build machine's paths, so building the DNAs from this
checkout produces different DNA hashes than the holochain-moq builds, and
`yarn pack:happs` will refuse until `apps/turbo-kart-desktop/expected-dna-hashes.json`
is deliberately updated.
