// The game mesh's network mode and what main passes to the sidecar. Internet mode
// (the default relay) unless --lan; --game-relay-url replaces the relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GAME_RELAY_URL, sidecarNetArgs, validateArgs, validateGameRelayUrl } from '../src/main/cli';

test('no option is Internet mode with the default relay', () => {
  const o = validateArgs({ profile: 'demo' });
  assert.equal(o.gameRelayUrl, DEFAULT_GAME_RELAY_URL);
  assert.deepEqual(sidecarNetArgs(o), ['--relay-url', DEFAULT_GAME_RELAY_URL]);
});

test('--lan is LAN mode: no extra sidecar arguments; it cannot be combined with a relay', () => {
  const o = validateArgs({ profile: 'demo', lan: true });
  assert.equal(o.gameRelayUrl, undefined);
  assert.equal(sidecarNetArgs(o), undefined);
  assert.throws(() => validateArgs({ lan: true, gameRelayUrl: DEFAULT_GAME_RELAY_URL }), /cannot be combined/);
});

test('a clean https relay selects Internet mode for the sidecar', () => {
  const url = 'https://dev-test-bootstrap2.holochain.org/';
  const o = validateArgs({ profile: 'inet', gameRelayUrl: url });
  assert.equal(o.gameRelayUrl, url);
  assert.deepEqual(sidecarNetArgs(o), ['--relay-url', url]);
  assert.equal(validateGameRelayUrl('https://relay.example:8443/relay'), 'https://relay.example:8443/relay');
});

test('insecure or malformed relay URLs are refused before anything starts', () => {
  for (const bad of [
    'http://relay.example/',
    'ws://relay.example/',
    'ftp://relay.example/',
    'relay.example',
    'https://',
    'https:///path',
    'https://user:pw@relay.example/',
    'https://relay.example/?token=1',
    'https://relay.example/#x',
    'https://relay .example/',
    'https://relay.example/\n',
    '',
    `https://${'r'.repeat(256)}.example/`,
  ]) {
    assert.throws(() => validateGameRelayUrl(bad), /--game-relay-url/, JSON.stringify(bad));
    assert.throws(() => validateArgs({ gameRelayUrl: bad }), /--game-relay-url/, JSON.stringify(bad));
  }
  assert.throws(() => validateGameRelayUrl(42), /must be a string/);
});
