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

The championship-cup update deliberately refreshed
`apps/turbo-kart-desktop/expected-dna-hashes.json` from this checkout, including
the new game validation for six maps and two cups. All multiplayer machines need
matching rebuilt hApps and sidecars. See the game's
[championship notes](../turbo-kart-rally-main/docs/CHAMPIONSHIPS.md).

The zome wasm embeds build paths: building from another checkout path changes the
DNA hashes. `yarn pack:happs` checks those hashes before packaging.
