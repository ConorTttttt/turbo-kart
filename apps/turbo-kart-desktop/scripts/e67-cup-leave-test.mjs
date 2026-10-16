// E6.7: leaving a championship between courses, in real desktops (own agents, conductors,
// Lair keystores, sidecars, iroh endpoints, renderers; the current game source). Karts are
// driven by the game's AIDriver (debug autopilot) through normal physics; one lap per course.
//
//   A. Alice hosts a cup with Bob. On the standings after course 1, Bob closes the app.
//      Alice must not be stranded: course 2 starts and finishes without Bob.
//   B. Alice hosts a new cup with Carol. On the standings after course 1, Alice (the host)
//      closes the app. Carol must be told the cup ended and get NEW LOBBY, not a wait.
//
//   E4_CONVERGENCE_MS=180000 sh scripts/with-clean-env.sh node scripts/e67-cup-leave-test.mjs
// Evidence: test-results/e67/<run>/; profiles: .test-data/<run id>/ (scripts/test-run.mjs).
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

const runCtx = createRun('e67', { desktops: 3 });
const run = runCtx.id.split('-').pop();
const output = path.resolve('test-results/e67', `${process.env.E67_LABEL ? process.env.E67_LABEL + '-' : ''}${run}`);
freshDir(output); // never reuses or empties an existing evidence directory
const expected = JSON.parse(fs.readFileSync('expected-dna-hashes.json'));
const gameRoot = path.resolve(process.env.TURBO_KART_GAME_DIR || '../../../turbo-kart-rally-main');
const results = [], desktops = [], identities = {}, metrics = { label: process.env.E67_LABEL || 'loopback' };
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
async function shot(d, name) { await sleep(1500); await screenshot(d, name); } // after the standings rows animate in
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

/** `host` creates a one-lap Cove Cup lobby, `guest` joins, the race starts; both in course 1. */
async function newCup(host, guest, n) {
  for (const d of [host, guest]) {
    if ((await gameState(d)) !== 'title') { await d.page(`window.__game.goToTitle(); true`); await until(`${d.name} title`, () => gameState(d), (s) => s === 'title', 30_000); }
    await click(d, '[data-action=multiplayer]'); await waitText(d, 'lobbies');
  }
  await act(host, '.multiplayer-screen [data-action=create]');
  await click(host, '.multiplayer-screen [data-mode=cup]'); await click(host, '.multiplayer-screen [data-course="cove-cup"]');
  await fields(host, { name: `E67-${run}-${n}`, capacity: '2', class: '150cc', laps: '1', character_id: 'rex' });
  await act(host, '.multiplayer-screen [data-action=submit]');
  await waitText(host, 'You are an active member');
  const lobbyId = await host.page(`document.querySelector('.mp-id').dataset.lobbyId`);
  await until(`${guest.name} sees lobby ${n}`, async () => { await act(guest, '.multiplayer-screen [data-action=refresh]').catch(() => null); return guest.page(`!!document.querySelector('[data-lobby-id="${lobbyId}"] [data-action=join]:not(:disabled)')`); });
  await act(guest, `[data-lobby-id="${lobbyId}"] [data-action=join]`);
  await fields(guest, { character_id: 'zippy' });
  await act(guest, '.multiplayer-screen [data-action=submit]');
  await waitText(guest, 'You are an active member');
  await waitText(host, '2/2 active');
  await until('host endpoint readiness and race start', () => host.page(`!!document.querySelector('[data-action=race-start]') && !document.querySelector('[data-action=race-start]').disabled`)
    .then((r) => r && act(host, '[data-action=race-start]').then(() => true, () => false)), Boolean, 120_000);
  await waitText(host, 'Admission locked'); await waitText(guest, 'Admission locked');
  await act(host, '[data-action=enter-race]');
  await act(guest, '[data-action=enter-race]');
  await until(`cup ${n} course 1 scenes`, async () => Promise.all([net(host), net(guest)]), (v) => v.every((x) => x && x.karts.length === 8), 120_000);
  return lobbyId;
}
const setAutopilot = (d, on) => d.page(`(window.__game.debug.autopilot = ${on}, true)`);
const standingsText = (d) => d.page(`(() => { const r = window.__game.hud.resultsEl; return r && !r.classList.contains('hidden') ? r.textContent : null; })()`);
const cupRound = (d) => d.page('window.__game.world && window.__game.world.cupRound');
/** Autopilot the course to its end; every racer in `group` reaches the standings. */
async function finishCourse(group, label) {
  for (const d of group) await setAutopilot(d, true);
  await until(`${label}: standings on ${group.map((d) => d.name).join(' & ')}`, async () => Promise.all(group.map(standingsText)),
    (v) => v.every((t) => t && /STANDINGS|WINS THE CUP/.test(t)), 240_000);
  for (const d of group) await setAutopilot(d, false);
}
const pressRestart = (d) => d.page(`(() => { const b = window.__game.hud.resultsEl.querySelector('[data-act=restart]'); if (!b || b.disabled) throw new Error('restart missing/disabled'); const t = b.textContent; b.click(); return t; })()`);

try {
  const port = await getPort({ host: '127.0.0.1' });
  const url = `http://127.0.0.1:${port}/`;
  log = fs.createWriteStream(path.join(output, 'network.log'));
  service = spawn(process.env.E4_BOOTSTRAP_BIN || 'kitsune2-bootstrap-srv', ['--listen', `127.0.0.1:${port}`, '--quic-bind-addr', '127.0.0.1:0'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  runCtx.own('bootstrap', service);
  service.stdout.pipe(log); service.stderr.pipe(log); service.exited = new Promise((resolve) => service.once('exit', resolve));
  await until('local network health', async () => { try { return (await fetch(url + 'health', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, Boolean, 10_000);
  const gameSha = crypto.createHash('sha256');
  for (const f of ['src/main.js', 'src/cup-session.js', 'src/netplay.js', 'src/championship.js']) gameSha.update(f).update(fs.readFileSync(path.join(gameRoot, f)));
  save('network.json', { url, expected, gameRoot, gameSourcesSha256: gameSha.digest('hex'), runId: runCtx.id, profiles: runCtx.dir, preflight: runCtx.preflight });
  const mk = (name, profile) => { const d = new Desktop(name, runCtx.profile(profile), output, url); d.onSpawn = (child) => runCtx.own(name, child); return d; };
  const alice = mk('alice', 'a'), bob = mk('bob', 'b'), carol = mk('carol', 'c');
  for (const d of [alice, bob, carol]) { desktops.push(d); await d.start(); identities[d.name] = await d.identity(expected); }
  await ready([alice, bob, carol]);
  // Side by side: a covered window stops painting and its screenshots go stale.
  for (const [i, d] of [alice, bob, carol].entries()) await d.main(`async E => { const a = E.screen.getPrimaryDisplay().workArea; const w = ${W}; const third = Math.floor(a.width / 3);
    w.setBounds({ x: a.x + third * ${i}, y: a.y, width: third, height: Math.min(720, a.height) }); return true; }`);

  // ============================================ A. a racer leaves between courses
  await newCup(alice, bob, 'A');
  check('A-cup-course-1-on-both', (await cupRound(alice)) === 0 && (await cupRound(bob)) === 0);
  await finishCourse([alice, bob], 'A course 1');
  await shot(bob, 'A-bob-standings');
  // Bob closes the game on the standings screen (a normal quit, as a player would).
  const bobStopped = Date.now();
  await bob.stop();
  check('A-bob-closed-the-game', true, 'Bob quit from the standings after course 1');
  await pressRestart(alice);
  const advanced = await until('Alice goes on to course 2 without Bob', () => cupRound(alice), (r) => r === 1, 60_000).then(() => true, () => false);
  note('A-alice-continued-after-ms', String(Date.now() - bobStopped));
  check('A-host-not-stranded-course-2-loads', advanced, 'cupRound 1 on Alice');
  await until('course 2 racing on Alice', () => gameState(alice), (s) => s === 'racing', 60_000);
  await screenshot(alice, 'A-alice-course-2-racing');
  await finishCourse([alice], 'A course 2');
  const standings2 = await standingsText(alice);
  check('A-course-2-completes-without-bob', /COURSE 2 \/ 3/.test(standings2), standings2.slice(0, 200));
  await shot(alice, 'A-alice-course-2-standings');

  // ============================================ B. the host leaves between courses
  await newCup(alice, carol, 'B');
  await finishCourse([alice, carol], 'B course 1');
  await shot(carol, 'B-carol-standings');
  await pressRestart(carol); // Carol is ready and waiting for the host
  const aliceStopped = Date.now();
  await alice.stop();
  const told = await until('Carol is told the host left', () => standingsText(carol), (t) => t && /THE HOST LEFT/.test(t), 60_000).then((t) => t, () => null);
  note('B-carol-told-after-ms', String(Date.now() - aliceStopped));
  await shot(carol, 'B-carol-host-left');
  check('B-guest-told-cup-ended', !!told, told ? told.slice(0, 200) : 'still waiting');
  check('B-new-lobby-offered', (await pressRestart(carol).catch((e) => String(e))) === 'NEW LOBBY');
  const lobbies = await until('Carol back in Multiplayer', () => carol.page(`!!document.querySelector('.multiplayer-screen')`), Boolean, 60_000).then(() => true, () => false);
  check('B-guest-can-leave-to-multiplayer', lobbies);
  const errs = await carol.page('window.__game.errors()');
  check('no-game-errors-on-carol', errs.length === 0, JSON.stringify(errs).slice(0, 300));
} catch (error) {
  results.push({ id: 'aborted', ok: false, detail: String(error) });
  console.error(error);
  for (const d of desktops) {
    if (!d.child || !alive(d.child.pid)) continue;
    await screenshot(d, `${d.name}-failure`);
    try { save(`${d.name}-failure-net.json`, await net(d)); } catch { /* best effort */ }
    try { save(`${d.name}-failure-standings.json`, { standings: await standingsText(d), state: await gameState(d) }); } catch { /* best effort */ }
  }
} finally {
  await cleanup();
  save('results.json', results); save('identities.json', identities); save('waits.json', elapsedWaits);
  save('run.json', { runId: runCtx.id, dir: runCtx.dir, preflight: runCtx.preflight, cleanup: await runCtx.finish({ ok: results.every((r) => r.ok) }) });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed; evidence: ${output}; run: ${runCtx.id}`);
process.exitCode = failed.length ? 1 : 0;
