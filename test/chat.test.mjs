import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createChatServer } from '../server.mjs';
import { encrypt, decrypt, importRoomKey, randomSecret, parseInvite } from '../public/crypto.js';

async function fixture(t) {
  const server = createChatServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  t.after(() => { controllers.forEach(c => c.abort()); server.closeAllConnections(); server.close(); });
  async function api(path, token, body, method = 'POST') {
    return fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  async function room(name = 'Research group') {
    const id = crypto.randomUUID(), access = randomSecret(), secret = randomSecret(), key = await importRoomKey(secret);
    const metadata = await encrypt(key, { name }, `${id}:metadata`);
    const result = await api('/api/rooms', null, { id, accessToken: access, metadata }); assert.equal(result.status, 201);
    return { id, access, key, secret, metadata };
  }
  async function join(room, name) {
    const id = crypto.randomUUID(); const profile = await encrypt(room.key, { name }, `${room.id}:profile:${id}`);
    const response = await api(`/api/rooms/${room.id}/join`, room.access, { id, profile }); assert.equal(response.status, 200);
    return { id, profile, ...(await response.json()) };
  }
  async function stream(room, member) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${base}/api/rooms/${room.id}/events`, { headers: { Authorization: `Bearer ${member.memberToken}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); let buffer = ''; const decoder = new TextDecoder();
    return { async next(type) {
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        while (true) {
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (block.startsWith(`event: ${type}\n`)) return JSON.parse(block.split('\ndata: ')[1]);
          }
          const { value, done } = await reader.read(); if (done) throw new Error('Stream closed'); buffer += decoder.decode(value, { stream: true });
        }
      } finally { clearTimeout(timeout); }
    } };
  }
  return { api, room, join, stream, base };
}
test('AES-GCM protects Unicode, rejects wrong keys, tampering and changed context', async () => {
  const key = await importRoomKey(randomSecret());
  const original = { text: 'Hello 👋 नमस्ते <script>alert(1)</script>\nPrivate words' };
  const payload = await encrypt(key, original, 'room:sender:id');
  assert.deepEqual(await decrypt(key, payload, 'room:sender:id'), original);
  assert.notEqual((await encrypt(key, original, 'room:sender:id')).iv, payload.iv);
  await assert.rejects(decrypt(await importRoomKey(randomSecret()), payload, 'room:sender:id'));
  await assert.rejects(decrypt(key, payload, 'another-room:sender:id'));
  await assert.rejects(decrypt(key, { ...payload, ciphertext: (payload.ciphertext[0] === 'A' ? 'B' : 'A') + payload.ciphertext.slice(1) }, 'room:sender:id'));
});
test('three users receive the same ciphertext through the server; reconnect replays encrypted history', async t => {
  const f = await fixture(t); const room = await f.room();
  const users = await Promise.all(['Alice', 'Bob', 'Charlie'].map(name => f.join(room, name)));
  const streams = await Promise.all(users.map(user => f.stream(room, user)));
  for (const stream of streams) assert.deepEqual(await stream.next('history'), []);
  const id = crypto.randomUUID(), sender = users[0].id;
  const context = `${room.id}:message:${sender}:${id}`;
  const payload = await encrypt(room.key, { text: 'The secret research plan 🌿' }, context);
  const response = await f.api(`/api/rooms/${room.id}/messages`, users[0].memberToken, { id, sender, payload }); assert.equal(response.status, 200);
  for (const stream of streams) {
    const event = await stream.next('message');
    assert.equal(JSON.stringify(event).includes('secret research plan'), false);
    assert.equal(JSON.stringify(event).includes('Alice'), false);
    assert.deepEqual(event.payload, payload);
    assert.equal((await decrypt(room.key, event.payload, context)).text, 'The secret research plan 🌿');
  }
  const replay = await f.stream(room, users[1]); const history = await replay.next('history'); assert.equal(history.length, 1); assert.equal(history[0].id, id);
  const duplicate = await f.api(`/api/rooms/${room.id}/messages`, users[0].memberToken, { id, sender, payload }); assert.equal((await duplicate.json()).duplicate, true);
  const fresh = await f.stream(room, users[2]); assert.equal((await fresh.next('history')).length, 1);
});
test('access control isolates rooms and rejects spoofing, plaintext, reused nonces and cross-origin writes', async t => {
  const f = await fixture(t); const room = await f.room(); const other = await f.room('Other');
  const member = await f.join(room, 'Alice');
  assert.equal((await f.api(`/api/rooms/${room.id}/join`, randomSecret(), {})).status, 403);
  assert.equal((await f.api(`/api/rooms/${other.id}/messages`, member.memberToken, {})).status, 401);
  assert.equal((await f.api(`/api/rooms/${room.id}/events`, room.access, null, 'GET')).status, 401);
  const id = crypto.randomUUID(); const payload = await encrypt(room.key, { text: 'private' }, `${room.id}:message:${member.id}:${id}`);
  assert.equal((await f.api(`/api/rooms/${room.id}/messages`, member.memberToken, { id, sender: crypto.randomUUID(), payload })).status, 400);
  assert.equal((await f.api(`/api/rooms/${room.id}/messages`, member.memberToken, { id, sender: member.id, payload: { text: 'plaintext' } })).status, 400);
  assert.equal((await f.api(`/api/rooms/${room.id}/messages`, member.memberToken, { id, sender: member.id, payload })).status, 200);
  assert.equal((await f.api(`/api/rooms/${room.id}/messages`, member.memberToken, { id: crypto.randomUUID(), sender: member.id, payload })).status, 409);
  const cross = await fetch(`${f.base}/api/rooms`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(cross.status, 403);
  assert.equal((await f.api(`/api/rooms/${room.id}/leave`, member.memberToken)).status, 200);
  assert.equal((await f.api(`/api/rooms/${room.id}/messages`, member.memberToken, {})).status, 401);
});
test('invite secrets stay in fragment and malformed invites are rejected', () => {
  const id = crypto.randomUUID(), secret = randomSecret(), access = randomSecret();
  const url = new URL(`https://chat.example/#room=${id}&key=${secret}&access=${access}`);
  assert.equal(url.pathname + url.search, '/');
  assert.deepEqual(parseInvite(url.href), { id, secret, access });
  assert.throws(() => parseInvite('https://chat.example/#room=oops'));
});
test('static application has security headers and cannot read arbitrary files', async t => {
  const f = await fixture(t);
  const index = await fetch(f.base); assert.equal(index.status, 200); assert.match(await index.text(), /Hush/);
  assert.match(index.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(index.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal((await fetch(`${f.base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${f.base}/package.json`)).status, 404);
});
