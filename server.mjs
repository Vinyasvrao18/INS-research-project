import http from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const digest = value => createHash('sha256').update(value).digest();
const equalSecret = (value, hash) => typeof value === 'string' && timingSafeEqual(digest(value), hash);
const envelope = (v, max = 24000) => v && typeof v.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(v.iv) && typeof v.ciphertext === 'string' && v.ciphertext.length >= 22 && v.ciphertext.length <= max && /^[A-Za-z0-9_-]+$/.test(v.ciphertext) && Object.keys(v).every(k => ['iv', 'ciphertext'].includes(k));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function readJSON(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) fail(413, 'Message is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON.'); }
}
function send(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

export function createChatServer() {
  const rooms = new Map();
  const createLimits = new Map();
  const event = (res, type, data) => {
    if (res.destroyed || res.writableEnded || res.writableLength > 262144) { if (!res.destroyed) res.destroy(); return; }
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (room, type, data) => { for (const member of room.members.values()) if (member.stream) event(member.stream, type, data); };
  const presence = room => broadcast(room, 'presence', [...room.members.values()].filter(m => m.stream).map(m => ({ id: m.id, profile: m.profile })));
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, 'Cross-origin requests are not allowed.');
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        if (rooms.size >= 200) fail(503, 'The server is full. Please try later.');
        const ip = req.socket.remoteAddress;
        const limit = createLimits.get(ip) || { count: 0, start: Date.now() };
        if (Date.now() - limit.start > 3600000) { limit.count = 0; limit.start = Date.now(); }
        if (++limit.count > 30) fail(429, 'Room creation limit reached. Try again in an hour.');
        createLimits.set(ip, limit);
        const body = await readJSON(req);
        if (!UUID.test(body.id) || !SECRET.test(body.accessToken) || !envelope(body.metadata, 2048)) fail(400, 'Invalid room.');
        if (rooms.has(body.id)) fail(409, 'Room already exists.');
        rooms.set(body.id, { id: body.id, accessHash: digest(body.accessToken), metadata: body.metadata, members: new Map(), history: [], ids: new Set(), usedIVs: new Set([body.metadata.iv]), touched: Date.now() });
        return send(res, 201, { id: body.id });
      }
      const match = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/(join|events|messages|leave)$/i);
      if (match) {
        const [, id, action] = match;
        const room = rooms.get(id);
        if (!room) fail(404, 'This room has expired or the server restarted. Create a new room.');
        const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
        if (action === 'join' && req.method === 'POST') {
          if (!equalSecret(token, room.accessHash)) fail(403, 'The invite does not grant access to this room.');
          if (room.members.size >= 50) fail(409, 'This room has reached its 50-person limit.');
          const body = await readJSON(req);
          if (!UUID.test(body.id) || !envelope(body.profile, 2048)) fail(400, 'Invalid profile.');
          if (room.members.has(body.id)) fail(409, 'This session already joined.');
          if (room.usedIVs.has(body.profile.iv)) fail(409, 'Encryption nonce already used.');
          room.usedIVs.add(body.profile.iv);
          const memberToken = randomBytes(32).toString('base64url');
          room.members.set(body.id, { id: body.id, profile: body.profile, tokenHash: digest(memberToken), stream: null, seen: Date.now(), count: 0, window: Date.now() });
          room.touched = Date.now();
          return send(res, 200, { memberToken, metadata: room.metadata });
        }
        const member = [...room.members.values()].find(m => equalSecret(token, m.tokenHash));
        if (!member) fail(401, 'Session expired. Reopen this room to reconnect.');
        member.seen = room.touched = Date.now();
        if (action === 'events' && req.method === 'GET') {
          if (member.stream) member.stream.end();
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          member.stream = res;
          event(res, 'history', room.history);
          presence(room);
          const heartbeat = setInterval(() => { if (res.destroyed || res.writableEnded) return; res.write(': heartbeat\n\n'); member.seen = room.touched = Date.now(); }, 15000);
          res.on('close', () => { clearInterval(heartbeat); if (member.stream === res) { member.stream = null; member.seen = Date.now(); presence(room); } });
          return;
        }
        if (action === 'messages' && req.method === 'POST') {
          if (Date.now() - member.window >= 10000) { member.count = 0; member.window = Date.now(); }
          if (++member.count > 30) fail(429, 'You are sending quickly. Wait a few seconds.');
          const body = await readJSON(req);
          if (!UUID.test(body.id) || body.sender !== member.id || !envelope(body.payload)) fail(400, 'Invalid encrypted message.');
          // A retry is acknowledged without broadcasting the same message twice.
          if (room.ids.has(body.id)) return send(res, 200, { accepted: true, duplicate: true });
          if (room.usedIVs.has(body.payload.iv)) fail(409, 'Encryption nonce already used.');
          if (room.ids.size >= 10000) fail(409, 'This room is full. Create a new room to continue.');
          room.ids.add(body.id); room.usedIVs.add(body.payload.iv);
          const message = { id: body.id, sender: member.id, profile: member.profile, payload: body.payload, time: new Date().toISOString() };
          room.history.push(message);
          if (room.history.length > 200) room.history.shift();
          broadcast(room, 'message', message);
          return send(res, 200, { accepted: true });
        }
        if (action === 'leave' && req.method === 'POST') {
          room.members.delete(member.id); member.stream?.end(); presence(room);
          return send(res, 200, { ok: true });
        }
        fail(405, 'Method not allowed.');
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/crypto.js': ['crypto.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, type] = files[url.pathname];
        const content = await readFile(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(content);
      }
      fail(404, 'Not found.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 500, { error: error.status ? error.message : 'Server error. Please try again.' });
      else res.end();
    }
  });
  const sweep = setInterval(() => {
    for (const [id, room] of rooms) {
      for (const [memberId, m] of room.members) if (!m.stream && Date.now() - m.seen > 120000) room.members.delete(memberId);
      if (Date.now() - room.touched > 86400000) rooms.delete(id);
    }
    for (const [ip, limit] of createLimits) if (Date.now() - limit.start > 3600000) createLimits.delete(ip);
  }, 30000);
  sweep.unref();
  server.on('close', () => { clearInterval(sweep); for (const room of rooms.values()) for (const m of room.members.values()) m.stream?.end(); });
  return server;
}

if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('Invalid PORT. Use a whole number from 0 to 65535 (0 chooses a free port).');
    process.exitCode = 1;
  } else {
    const server = createChatServer();
    server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Hush could not start: ${host}:${port} is already in use.`);
        console.error('Stop an earlier Hush instance with Ctrl+C in its terminal, or choose another port:');
        console.error('  Linux/macOS: PORT=3001 npm run dev');
        console.error('  PowerShell:  $env:PORT="3001"; npm run dev');
        console.error('Then open http://localhost:3001 (on the computer running Hush).');
      } else {
        console.error(`Hush could not start (${error.code || 'error'}): ${error.message}`);
      }
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      const addressHost = host.includes(':') ? `[${host}]` : host;
      console.log(`Hush is running at http://${addressHost}:${server.address().port}`);
    });
  }
}
