// E6.6: online items (game docs/ONLINE-ITEMS.md) in two real desktops (own agents,
// conductors, Lair keystores, sidecars, iroh endpoints, renderers; the current game
// source). Items are used with the real item key; the host's netGiveItem test hook stands
// in for driving through a box, except in the box check, which takes a real box. To make
// each hit deterministic, a player's own page places its own kart (Kart.reset) beside the
// other one first; its pose then travels like any other.
//
//   E4_CONVERGENCE_MS=180000 sh scripts/with-clean-env.sh node scripts/e66-items-test.mjs
//   E66_LABEL=loss2      a label for the evidence (e.g. when run under scripts/netem-run.sh)
// Evidence: test-results/e66/<run>/; profiles: .test-data/<run id>/ (scripts/test-run.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import getPort from 'get-port';
import { decodeHashFromBase64 } from '@holochain/client';
import { Desktop, until, bounded, elapsedWaits, alive, killGroup } from './e4-desktop.mjs';
import { createRun } from './test-run.mjs';
import { freshDir } from './evidence.mjs';

const runCtx = createRun('e66', { desktops: 2 });
const run = runCtx.id.split('-').pop();
const output = path.resolve('test-results/e66', `${process.env.E66_LABEL ? process.env.E66_LABEL + '-' : ''}${run}`);
freshDir(output); // never reuses or empties an existing evidence directory
const expected = JSON.parse(fs.readFileSync('expected-dna-hashes.json'));
const gameRoot = path.resolve(process.env.TURBO_KART_GAME_DIR || '../../../turbo-kart-rally-main');
const results = [], desktops = [], identities = {}, metrics = { label: process.env.E66_LABEL || 'loopback' };
let service, log;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (file, value) => fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2));
function check(id, ok, detail = '') { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`); assert.ok(ok, `${id} ${detail}`); }
function note(id, detail) { results.push({ id, ok: true, detail, note: true }); console.log(`NOTE ${id} ${detail}`); }
const W = "E.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('webhapp://webhappwindow'))";
const click = (d, selector) => d.page(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n || n.disabled) throw new Error('missing/disabled ${selector}'); n.click(); return true; })()`);
const idle = (d) => until(`${d.name} lobby idle`, () => d.page(`(() => { const m = document.querySelector('.multiplayer-screen'); return !m || (m.getAttribute('aria-busy') !== 'true' && !m.classList.contains('mp-working')); })()`), Boolean, 30_000);
const act = async (d, selector) => { await idle(d); await click(d, selector); };
const text = (d) => d.page(`document.querySelector('.multiplayer-screen').textContent`);
const waitText = (d, wanted) => until(`${d.name} UI ${wanted}`, () => text(d), (s) => s.includes(wanted));
async function fields(d, values) {
  await d.page(`(() => { for (const [key, value] of Object.entries(${JSON.stringify(values)})) {
    const n = document.querySelector('.multiplayer-screen [name="' + key + '"]' + (key === 'character_id' ? '[value="' + value + '"]' : ''));
    if (!n) throw new Error('missing field ' + key);
    if (n.type === 'radio' || n.type === 'checkbox') n.checked = key === 'character_id' ? true : value; else n.value = value;
    n.dispatchEvent(new Event('change', { bubbles: true }));
  } return true; })()`);
}
async function ready(group) {
  await until('game network readiness', async () => Promise.all(group.map(async (d) => ({
    name: d.name, agent: d.agent,
    info: (await d.admin.agentInfo({ dna_hashes: [decodeHashFromBase64(expected.turbo_kart)] })).map((s) => JSON.parse(JSON.parse(s).agentInfo)),
    stats: (await d.admin.dumpNetworkStats()).transport_stats,
  }))), (views) => views.every((v) => views.every((peer) => {
    const key = Buffer.from(decodeHashFromBase64(peer.agent).subarray(3, 35)).toString('base64url');
    const info = v.info.find((i) => i.agent === key && !i.isTombstone && i.storageArc !== null);
    if (!info || !peer.stats.peer_urls.includes(info.url)) return false;
    return v.name === peer.name || v.stats.connections.some((c) => c.pub_key === new URL(info.url).pathname.slice(1) && c.send_message_count > 0 && c.recv_message_count > 0);
  })));
}
async function screenshot(d, name) {
  try { await d.main(`async (E, require) => { require('fs').writeFileSync(${JSON.stringify(output)} + '/${name}.png', (await ${W}.webContents.capturePage()).toPNG()); return true; }`); }
  catch (e) { console.log(`(screenshot ${name} failed: ${String(e).slice(0, 80)})`); }
}
const net = (d) => d.page('window.__game.net');
const gameState = (d) => d.page('window.__game.state');
const session = (d) => d.value('sessionStatus');
async function hold(d, keyCode, ms) {
  await d.main(`async (E) => { const w = ${W}; w.focus(); w.webContents.focus(); w.webContents.sendInputEvent({ type: 'keyDown', keyCode: '${keyCode}' }); return true; }`);
  await sleep(ms);
  await d.main(`async (E) => { ${W}.webContents.sendInputEvent({ type: 'keyUp', keyCode: '${keyCode}' }); return true; }`);
}
const kartOf = (view, agent) => view.karts.find((k) => k.agent === agent);
const aiOf = (view, slot) => view.karts.find((k) => k.aiSlot === slot);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
/** Sum of every model node's rotation: changes iff the kart's model is animating. */
const modelSignature = (d, sel) => d.page(`(() => { const ks = window.__game.world.karts.filter(${sel}); return ks.map((k) => { let s = 0; k.model && k.model.root && k.model.root.traverse((o) => { s += Math.abs(o.rotation.x) + Math.abs(o.rotation.y); }); return { index: k.index, sig: s }; }); })()`);

let cleaning;
async function cleanup() {
  if (cleaning) return cleaning;
  return cleaning = (async () => {
    for (const d of [...desktops].reverse()) {
      try { await d.stop(); check(`${d.name}-shutdown`, true); }
      catch (e) { results.push({ id: `${d.name}-shutdown`, ok: false, detail: String(e) }); killGroup(d.child); }
    }
    if (service) { killGroup(service, 'SIGTERM'); await bounded(service.exited, 5000, 'network shutdown').catch(() => killGroup(service)); check('network-shutdown', !alive(service.pid)); }
    log?.end();
  })();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { results.push({ id: 'interrupted', ok: false, detail: signal }); void cleanup().then(() => { save('results.json', results); process.exit(1); }); });

/** Lobby → race start → both "Enter race" → both in the scene. Returns the admission. */
async function newRace(alice, bob, n) {
  for (const d of [alice, bob]) {
    if ((await gameState(d)) !== 'title') { await d.page(`window.__game.goToTitle(); true`); await until(`${d.name} title`, () => gameState(d), (s) => s === 'title', 30_000); }
    await click(d, '[data-action=multiplayer]'); await waitText(d, 'lobbies');
  }
  await act(alice, '.multiplayer-screen [data-action=create]');
  await fields(alice, { name: `E66-${run}-${n}`, capacity: '2', class: '100cc', laps: '3', character_id: 'rex' });
  await act(alice, '.multiplayer-screen [data-action=submit]');
  await waitText(alice, 'You are an active member');
  const lobbyId = await alice.page(`document.querySelector('.mp-id').dataset.lobbyId`);
  await until(`Bob sees lobby ${n}`, async () => { await act(bob, '.multiplayer-screen [data-action=refresh]').catch(() => null); return bob.page(`!!document.querySelector('[data-lobby-id="${lobbyId}"] [data-action=join]:not(:disabled)')`); });
  await act(bob, `[data-lobby-id="${lobbyId}"] [data-action=join]`);
  await fields(bob, { character_id: 'zippy' });
  await act(bob, '.multiplayer-screen [data-action=submit]');
  await waitText(bob, 'You are an active member');
  await waitText(alice, '2/2 active');
  // The button re-checks endpoint bindings on every lobby refresh; under netem a slow
  // DHT read can disable it again between the readiness check and the click, so retry.
  await until('host endpoint readiness and race start', () => alice.page(`!!document.querySelector('[data-action=race-start]') && !document.querySelector('[data-action=race-start]').disabled`)
    .then((ready) => ready && act(alice, '[data-action=race-start]').then(() => true, () => false)), Boolean, 120_000);
  await waitText(alice, 'Admission locked'); await waitText(bob, 'Admission locked');
  const record = (await alice.value('raceGet', lobbyId)).race;
  await act(alice, '[data-action=enter-race]');
  await act(bob, '[data-action=enter-race]');
  await until(`race ${n} scenes`, async () => Promise.all([net(alice), net(bob)]), (v) => v.every((x) => x && x.karts.length === 8), 120_000);
  return { lobbyId, record };
}
const quitRace = async (d) => { await d.page(`window.__game.goToTitle(); true`); await until(`${d.name} back at title`, () => gameState(d), (s) => s === 'title', 30_000); };


const items = (d) => d.page('window.__game.net && window.__game.net.items');
const kartIndex = (view, agent) => view.karts.findIndex((k) => k.agent === agent);
/** Press the item key (with Down held: fire backwards) on `d`'s own kart. */
async function useItem(d, backward = false) {
  if (backward) await d.main(`async (E) => { const w = ${W}; w.focus(); w.webContents.focus(); w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' }); return true; }`);
  await hold(d, 'E', 120);
  if (backward) await d.main(`async (E) => { ${W}.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' }); return true; }`);
}
/** Place `d`'s own kart `back` metres behind kart `of` (same heading), and keep it still. */
const placeBehind = (d, of, back) => d.page(`(() => { const w = window.__game.world, a = w.karts[${of}], p = a.position.clone(), h = a.heading;
  p.x -= Math.sin(h) * ${back}; p.z -= Math.cos(h) * ${back}; w.player.reset(p, h); return [p.x, p.z]; })()`);
/** Poll `d` until kart `index` shows effect `pred`, for up to `ms`; returns the first view that did. */
async function watch(d, index, pred, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await net(d);
    if (v && pred(v.karts[index].effects, v.karts[index])) return v.karts[index];
    await sleep(40);
  }
  return null;
}

try {
  // ---------------------------------------------------------------- setup (as E6.4)
  const port = await getPort({ host: '127.0.0.1' });
  const url = `http://127.0.0.1:${port}/`;
  log = fs.createWriteStream(path.join(output, 'network.log'));
  service = spawn(process.env.E4_BOOTSTRAP_BIN || 'kitsune2-bootstrap-srv', ['--listen', `127.0.0.1:${port}`, '--quic-bind-addr', '127.0.0.1:0'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  runCtx.own('bootstrap', service);
  service.stdout.pipe(log); service.stderr.pipe(log); service.exited = new Promise((resolve) => service.once('exit', resolve));
  await until('local network health', async () => { try { return (await fetch(url + 'health', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, Boolean, 10_000);
  const gameSha = crypto.createHash('sha256');
  for (const f of ['src/main.js', 'src/netplay.js', 'src/kart.js', 'src/items.js', 'src/custom-powerups.js', 'src/net-items.js', 'src/net-items-codec.js']) gameSha.update(f).update(fs.readFileSync(path.join(gameRoot, f)));
  save('network.json', { url, expected, gameRoot, gameSourcesSha256: gameSha.digest('hex'), runId: runCtx.id, profiles: runCtx.dir, preflight: runCtx.preflight, netns: process.env.E66_LABEL || null });
  const mk = (name, profile) => { const d = new Desktop(name, runCtx.profile(profile), output, url); d.onSpawn = (child) => runCtx.own(name, child); return d; };
  const alice = mk('alice', 'a'), bob = mk('bob', 'b');
  for (const d of [alice, bob]) { desktops.push(d); await d.start(); identities[d.name] = await d.identity(expected); }
  check('separate-agents-conductors-lairs-sidecars', alice.agent !== bob.agent && alice.children().sidecars[0].pid !== bob.children().sidecars[0].pid);
  await ready([alice, bob]);
  for (const [i, d] of [alice, bob].entries()) await d.main(`async E => { const a = E.screen.getPrimaryDisplay().workArea; const w = ${W}; w.setBounds({ x: a.x + Math.floor(a.width / 2) * ${i}, y: a.y, width: Math.min(960, Math.floor(a.width / 2)), height: Math.min(720, a.height) }); return true; }`);

  const r1 = await newRace(alice, bob, 1);
  save('admission.json', r1.record);
  const ga = await net(alice);
  const A = kartIndex(ga, alice.agent), B = kartIndex(ga, bob.agent);
  check('host-is-alice', ga.isHost === true && (await net(bob)).isHost === false, `kart ${A} hosts, Bob is kart ${B}`);

  // ------------------------------------------------ items turn on (every racer said HELLO)
  const on = await until('items on, both', async () => Promise.all([items(alice), items(bob)]), (v) => v.every((x) => x && x.enabled && x.boxes > 0), 60_000);
  check('items-enabled-and-boxes-on-both', true, `boxes alice ${on[0].boxes}, bob ${on[1].boxes}`);
  await until('both racing', async () => Promise.all([gameState(alice), gameState(bob)]), (s) => s.every((x) => x === 'racing'), 60_000);
  await screenshot(alice, 'alice-at-go'); await screenshot(bob, 'bob-at-go');

  // ------------------------------------------------ 1. client fires: Bob's shockwave spins Alice
  // Bob parks 6 m behind Alice (both still on the start straight).
  await placeBehind(bob, A, 6); await sleep(800);
  check('give-bob-shockwave', await alice.page(`window.__game.netGiveItem(${B}, 'shockwave')`));
  await until('Bob holds the shockwave', () => net(bob), (v) => v.karts[B].item === 'shockwave', 10_000);
  const aliceSees = watch(alice, A, (e) => e.hitKind === 'spin', 4000), bobSees = watch(bob, A, (e) => e.hitKind === 'spin', 4000);
  await useItem(bob);
  const [s1a, s1b] = await Promise.all([aliceSees, bobSees]);
  await screenshot(bob, 'bob-sees-alice-spin');
  check('1-client-item-hits-host-kart', !!s1a, "Alice's own kart spun (the host judged Bob's shockwave from Bob's pose)");
  check('1-client-sees-the-hit-it-caused', !!s1b, 'Bob sees Alice spin (host HIT, shown on the remote kart)');
  check('1-item-consumed-both-sides', (await net(bob)).karts[B].item === null && (await net(alice)).karts[B].item === null);

  // ------------------------------------------------ 2. host fires backwards: Alice freezes Bob
  await sleep(2600); // Alice's spin protection runs out
  await placeBehind(bob, A, 8); await sleep(1000);
  check('give-alice-freeze-ray', await alice.page(`window.__game.netGiveItem(${A}, 'freeze_ray')`));
  const bobFrozen = watch(bob, B, (e) => e.freeze > 0, 4000), aliceSeesFrozen = watch(alice, B, (e) => e.freeze > 0, 4000);
  await useItem(alice, true);
  const [f2b, f2a] = await Promise.all([bobFrozen, aliceSeesFrozen]);
  await screenshot(alice, 'alice-sees-bob-frozen'); await screenshot(bob, 'bob-frozen');
  check('2-host-item-hits-client-kart', !!f2b, "Bob's own kart froze (host HIT applied by Bob's racer)");
  check('2-host-sees-client-frozen', !!f2a, 'Alice sees Bob in the ice block');
  const thaw = await watch(bob, B, (e) => e.freeze === 0, 5000);
  check('2-client-thaws-on-both', !!thaw && !!(await watch(alice, B, (e) => e.freeze === 0, 3000)));

  // ------------------------------------------------ 3. client fires a projectile: Bob's cannonball flattens Alice
  await sleep(1500);
  await placeBehind(bob, A, 22); await sleep(1000);
  check('give-bob-cannonball', await alice.page(`window.__game.netGiveItem(${B}, 'cannonball')`));
  await until('Bob holds the cannonball', () => net(bob), (v) => v.karts[B].item === 'cannonball', 10_000);
  const flatA = watch(alice, A, (e) => e.hitKind === 'flatten', 4000), flatB = watch(bob, A, (e) => e.hitKind === 'flatten', 4000);
  await useItem(bob);
  const seenBall = await until('Bob draws the host cannonball', () => items(bob), (v) => v.entities > 0, 3000).then(() => true, () => false);
  const [c3a, c3b] = await Promise.all([flatA, flatB]);
  await screenshot(bob, 'bob-sees-alice-flattened');
  check('3-client-draws-host-projectile', seenBall);
  check('3-projectile-hits-host-kart', !!c3a && !!c3b, 'Alice flattened, seen on both desktops');
  const ended = await until('cannonball ended on both', async () => Promise.all([items(alice), items(bob)]), (v) => v.every((x) => x.entities === 0), 12_000).then(() => true, () => false);
  check('3-projectile-ended-on-both', ended);

  // ------------------------------------------------ 4. a real box: Bob drives through one; the host rolls
  const box = await bob.page(`(() => { const w = window.__game.world, b = w.items.boxes.find((x) => x.active); if (!b) return null;
    const h = w.player.heading; const p = b.base.clone(); p.x -= Math.sin(h) * 12; p.z -= Math.cos(h) * 12; const g = w.track.getSurfaceInfo(p)?.height; p.y = Number.isFinite(g) ? g : w.player.position.y;
    w.player.reset(p, Math.atan2(b.base.x - p.x, b.base.z - p.z)); return [b.base.x, b.base.z]; })()`);
  check('4-a-box-to-drive-through', !!box, JSON.stringify(box));
  await sleep(600);
  const rolled = until('Bob holds a rolled item', () => net(bob), (v) => !!v.karts[B].item, 8000).then((v) => v.karts[B].item, () => null);
  await hold(bob, 'Up', 1500);
  const got = await rolled;
  const hostRecord = (await net(alice)).karts[B].item;
  check('4-box-claim-rolled-by-host', !!got && got === hostRecord, `Bob holds ${got}; the host's record says ${hostRecord}`);

  // ------------------------------------------------ the session survived it all
  const [sa, sb, ia, ib] = await Promise.all([session(alice), session(bob), items(alice), items(bob)]);
  metrics.items = { alice: ia, bob: ib };
  check('session-still-connected', sa.state === 'connected' && sb.state === 'connected');
  check('no-item-sends-refused-and-budget-ok', ia.stats.refused === 0 && ib.stats.refused === 0 && !ia.budget.exhausted && !ib.budget.exhausted,
    `alice sent ${ia.stats.sent} (${ia.budget.bytes} B), bob sent ${ib.stats.sent} (${ib.budget.bytes} B), dropped ${ia.stats.dropped}/${ib.stats.dropped}`);
  const errs = await Promise.all([alice.page('window.__game.errors()'), bob.page('window.__game.errors()')]);
  check('no-game-errors', errs.every((e) => e.length === 0), JSON.stringify(errs).slice(0, 400));
  save('metrics.json', metrics);
} catch (error) {
  results.push({ id: 'aborted', ok: false, detail: String(error) });
  console.error(error);
  save('metrics.json', metrics);
  for (const d of desktops) {
    await screenshot(d, `${d.name}-failure`);
    try { save(`${d.name}-failure-net.json`, await net(d)); } catch { /* best effort */ }
    try { save(`${d.name}-failure-session.json`, await session(d)); } catch { /* best effort */ }
  }
} finally {
  await cleanup();
  save('results.json', results); save('identities.json', identities); save('waits.json', elapsedWaits);
  save('run.json', { runId: runCtx.id, dir: runCtx.dir, preflight: runCtx.preflight, cleanup: await runCtx.finish({ ok: results.every((r) => r.ok) }) });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed; evidence: ${output}; run: ${runCtx.id}`);
process.exitCode = failed.length ? 1 : 0;
