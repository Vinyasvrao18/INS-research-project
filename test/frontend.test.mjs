import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createChatServer } from '../server.mjs';
import * as cryptoHelpers from '../public/crypto.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/, 'const { randomSecret, importRoomKey, encrypt, decrypt, parseInvite, decode } = window.cryptoHelpers;\n');
async function until(condition, label, timeout = 6000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function fixture(t) {
  const server = createChatServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.window.dispatchEvent(new client.window.Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 50));
    for (const client of clients) { client.controllers.forEach(c => c.abort()); client.window.close(); }
    server.closeAllConnections(); server.close();
  });
  function client(name, url = base, saved = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const { window } = dom; const $ = selector => window.document.querySelector(selector);
    const controllers = [], requests = []; const state = { streams: 0, maxStreams: 0, failMessages: false, failSync: false, loseAck: false, clipboard: '', smallScreen: false };
    Object.defineProperty(window, 'crypto', { value: crypto });
    Object.assign(window, { cryptoHelpers, TextEncoder, TextDecoder, AbortController, matchMedia: () => ({ matches: state.smallScreen }) });
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => { state.clipboard = text; } } });
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    window.sessionStorage.setItem('hush-name', JSON.stringify(name));
    for (const [key, value] of Object.entries(saved)) window.sessionStorage.setItem(key, value);
    window.fetch = async (input, options = {}) => {
      const target = new URL(input, base);
      requests.push({ path: target.pathname, body: options.body, headers: options.headers });
      if (state.failMessages && target.pathname.endsWith('/messages')) throw new Error('Simulated network failure');
      if (state.failSync && /\/(events|sync)$/.test(target.pathname)) throw new Error('Simulated connection loss');
      const controller = new AbortController(); controllers.push(controller);
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const response = await fetch(target, { ...options, signal, headers: { ...options.headers, Origin: base } });
      if (state.loseAck && target.pathname.endsWith('/messages')) { state.loseAck = false; await response.text(); throw new Error('Simulated lost acknowledgement'); }
      if (target.pathname.endsWith('/events') && response.ok) {
        state.streams++; state.maxStreams = Math.max(state.maxStreams, state.streams);
        signal.addEventListener('abort', () => { state.streams--; }, { once: true });
      }
      return response;
    };
    const instance = { window, $, controllers, state, requests,
      async ready() { await until(() => !$('#message-input').disabled, `connect ${name}: ${$('#connection-error').textContent}`); },
      async submitDialog(values = {}) { for (const [key, value] of Object.entries(values)) $(`[name="${key}"]`).value = value; $('#dialog-form').requestSubmit(); await until(() => !$('#dialog-submit').disabled, 'dialog submitted'); assert.equal($('#dialog-error').textContent, ''); },
      async create(name) { $('.new-room').click(); await this.submitDialog({ room: name }); await this.ready(); },
      async invite() { $('#invite').click(); await this.submitDialog(); return state.clipboard; },
      async send(text) { $('#message-input').value = text; $('#message-input').dispatchEvent(new window.Event('input')); assert.equal($('#send').disabled, false); $('#message-form').requestSubmit(); },
      messages() { return [...window.document.querySelectorAll('.message-bubble')].map(el => el.textContent); },
    };
    clients.push(instance); window.eval(source); return instance;
  }
  return { client, server, base };
}

test('frontend: invite, two-way messaging, safe text, profile, presence and leave', { timeout: 20000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  await alice.create('Research room'); const invite = await alice.invite();
  const bob = f.client('Bob', invite); await bob.submitDialog({ name: 'Bob' }); await bob.ready();
  await until(() => alice.$('#member-count').textContent === '2', 'both members visible');
  assert.match(alice.$('#members').textContent, /Bob/);
  await alice.send('Hello Bob 👋'); await until(() => bob.messages().includes('Hello Bob 👋'), 'Alice to Bob');
  await bob.send('<img src=x onerror=alert(1)>\nHello Alice'); await until(() => alice.messages().some(v => v.includes('Hello Alice')), 'Bob to Alice');
  assert.equal(alice.$('#messages img'), null);
  assert.equal(alice.requests.filter(r => r.path.endsWith('/messages')).some(r => r.body.includes('Hello Bob')), false);
  assert.equal(bob.window.location.hash, '');
  bob.$('#leave-room').click(); await bob.submitDialog();
  await until(() => alice.$('#member-count').textContent === '1', 'leave presence');
});

test('frontend: switching rooms keeps drafts and does not retain background streams', { timeout: 20000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  alice.$('#message-input').value = 'A draft for my first room';
  await alice.create('Second room'); await alice.create('Third room');
  assert.ok(alice.state.streams <= 1, `Expected at most one active stream, found ${alice.state.streams}`);
  alice.$('.room-item').click(); await until(() => alice.$('#room-title').textContent === 'The common room', 'switch room');
  assert.equal(alice.$('#message-input').value, 'A draft for my first room');
});

test('frontend: failed sends preserve the draft and surface an error', { timeout: 15000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  alice.state.failMessages = true; await alice.send('Keep this draft');
  await until(() => !alice.$('#send').disabled, 'send failure completes');
  assert.equal(alice.$('#message-input').value, 'Keep this draft');
  assert.match(alice.$('#toast').textContent, /network failure/);
  assert.equal(alice.messages().length, 0);
});

test('frontend: a lost send acknowledgement can be retried without duplicate messages', { timeout: 15000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  alice.state.loseAck = true; await alice.send('Exactly once');
  await until(() => !alice.$('#send').disabled, 'lost acknowledgement handled');
  assert.equal(alice.$('#message-input').value, 'Exactly once');
  await alice.send('Exactly once');
  await until(() => alice.$('#message-input').value === '', 'retry acknowledged');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(alice.messages(), ['Exactly once']);
  const posts = alice.requests.filter(r => r.path.endsWith('/messages')).map(r => JSON.parse(r.body));
  assert.equal(posts[0].id, posts[1].id);
  assert.deepEqual(posts[0].payload, posts[1].payload);
});

test('frontend: disconnection recovers missed messages, preserves drafts and sender identity', { timeout: 20000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  const bob = f.client('Bob', await alice.invite()); await bob.submitDialog(); await bob.ready();
  await bob.send('Before disconnect'); await until(() => bob.messages().length === 1, 'initial send');
  bob.state.failSync = true;
  await until(() => bob.$('#message-input').disabled, 'detect disconnection');
  bob.$('#message-input').value = 'Unsent draft';
  await alice.send('Sent while Bob was offline');
  bob.state.failSync = false;
  await bob.ready(); await until(() => bob.messages().length === 2, 'replay missed message');
  assert.equal(bob.$('#message-input').value, 'Unsent draft');
  bob.$('#reconnect').click();
  await new Promise(resolve => setTimeout(resolve, 200)); await bob.ready();
  assert.equal(bob.$('#messages .mine .message-bubble').textContent, 'Before disconnect');
  assert.equal(bob.$('#message-input').value, 'Unsent draft');
});

test('frontend: expired member sessions rejoin automatically', { timeout: 15000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  await alice.send('My earlier message'); await until(() => alice.messages().length === 1, 'initial message');
  const sync = alice.requests.find(r => r.path.endsWith('/sync'));
  await fetch(f.base + sync.path.replace('/sync', '/leave'), { method: 'POST', headers: sync.headers });
  await until(() => alice.requests.filter(r => r.path.endsWith('/join')).length === 2, 'session rejoined');
  await alice.ready();
  await alice.send('After rejoin'); await until(() => alice.messages().length === 2, 'send after rejoin');
  assert.equal(alice.window.document.querySelectorAll('#messages .mine').length, 2);
});

test('frontend: room search, profile name, privacy fingerprint, navigation and keyboard controls', { timeout: 15000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  alice.$('#edit-profile').click(); await alice.submitDialog({ name: 'Alice Researcher' });
  assert.equal(alice.$('#my-name').textContent, 'Alice Researcher');
  await alice.create('Project group'); assert.match(alice.$('#members').textContent, /Alice Researcher/);
  alice.$('#room-search').value = 'project'; alice.$('#room-search').dispatchEvent(new alice.window.Event('input'));
  assert.equal(alice.window.document.querySelectorAll('.room-item').length, 1);
  alice.$('#room-search').value = 'does not exist'; alice.$('#room-search').dispatchEvent(new alice.window.Event('input'));
  assert.match(alice.$('#room-list').textContent, /No matching/);
  alice.$('#security-details').click(); await until(() => alice.$('#dialog').open, 'security dialog');
  assert.match(alice.$('#dialog-fields code').textContent, /^[0-9a-f]{4}( [0-9a-f]{4}){15}$/);
  alice.$('#dialog-close').click();
  alice.$('#details-toggle').click(); assert.equal(alice.$('.app').classList.contains('details-hidden'), true);
  alice.$('#details-toggle').click(); assert.equal(alice.$('.app').classList.contains('details-hidden'), false);
  alice.state.smallScreen = true;
  alice.$('#details-toggle').click(); assert.equal(alice.$('.app').classList.contains('show-details'), true);
  alice.$('#close-details').click(); assert.equal(alice.$('.app').classList.contains('show-details'), false);
  alice.$('#menu').click(); assert.equal(alice.$('.app').classList.contains('show-sidebar'), true);
  alice.$('.main').click(); assert.equal(alice.$('.app').classList.contains('show-sidebar'), false);
  assert.equal(alice.$('#send').disabled, true);
  const input = alice.$('#message-input'); input.value = 'Keyboard message'; input.dispatchEvent(new alice.window.Event('input'));
  const shiftEnter = new alice.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }); input.dispatchEvent(shiftEnter);
  assert.equal(shiftEnter.defaultPrevented, false); assert.equal(alice.messages().length, 0);
  input.dispatchEvent(new alice.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  await until(() => alice.messages().includes('Keyboard message'), 'Enter sends');
});

test('frontend: invalid invite keys fail safely, and identical room names do not merge rooms', { timeout: 15000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'), bob = f.client('Bob');
  await alice.ready(); await bob.ready();
  assert.equal(alice.$('#room-title').textContent, bob.$('#room-title').textContent);
  assert.notEqual(alice.$('#room-code').textContent, bob.$('#room-code').textContent);
  await alice.send('Only Alice can see this');
  await new Promise(resolve => setTimeout(resolve, 1000)); assert.equal(bob.messages().length, 0);
  const url = new URL(await alice.invite()); const params = new URLSearchParams(url.hash.slice(1)); params.set('key', cryptoHelpers.randomSecret()); url.hash = params.toString();
  bob.$('#join-room').click(); bob.$('[name="invite"]').value = url.href; bob.$('#dialog-form').requestSubmit();
  await until(() => !bob.$('#dialog-submit').disabled, 'invalid key handled');
  assert.match(bob.$('#dialog-error').textContent, /key could not unlock/);
  assert.equal(bob.messages().length, 0);
});

test('frontend: reload restores the room and recent encrypted history', { timeout: 15000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  await alice.send('Survives a tab reload'); await until(() => alice.messages().length === 1, 'initial message');
  const saved = Object.fromEntries(Object.keys(alice.window.sessionStorage).map(key => [key, alice.window.sessionStorage.getItem(key)]));
  alice.window.dispatchEvent(new alice.window.Event('pagehide'));
  const reload = f.client('Alice', f.base, saved); await reload.ready();
  assert.deepEqual(reload.messages(), ['Survives a tab reload']);
  assert.equal(reload.$('#room-code').textContent, alice.$('#room-code').textContent);
  assert.equal(reload.window.document.querySelectorAll('#messages .mine').length, 1);
});

test('frontend: reopening an already joined invite preserves room title and membership', { timeout: 15000 }, async t => {
  const f = await fixture(t); const alice = f.client('Alice'); await alice.ready();
  await alice.create('Invite again'); const invite = await alice.invite();
  alice.$('#join-room').click(); await alice.submitDialog({ invite }); await alice.ready();
  assert.equal(alice.$('#room-title').textContent, 'Invite again');
  assert.equal(alice.$('#member-count').textContent, '1');
  assert.equal(alice.requests.filter(r => r.path.endsWith('/join')).length, 2);
});
