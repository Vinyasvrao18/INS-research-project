import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../server.mjs', import.meta.url));
function launch(t, port) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, output: () => ({ stdout, stderr }), closed: once(child, 'close') };
}

test('occupied port produces recovery instructions without an unhandled stack trace', { timeout: 10000 }, async t => {
  const owner = net.createServer(); owner.listen(0, '127.0.0.1'); await once(owner, 'listening');
  t.after(() => owner.close());
  const app = launch(t, owner.address().port);
  const [code] = await app.closed;
  assert.equal(code, 1);
  assert.match(app.output().stderr, /already in use/);
  assert.match(app.output().stderr, /PORT=3001 npm run dev/);
  assert.doesNotMatch(app.output().stderr, /Unhandled|node:events|at Server/);
  assert.equal(owner.listening, true);
});

test('PORT=0 starts on a free port and prints the actual address', { timeout: 10000 }, async t => {
  const app = launch(t, 0);
  await once(app.child.stdout, 'data');
  assert.match(app.output().stdout, /Hush is running at http:\/\/127\.0\.0\.1:[1-9]\d*/);
  assert.equal(app.output().stderr, '');
  app.child.kill(); await app.closed;
});

test('invalid PORT gives a clear configuration error', { timeout: 10000 }, async t => {
  const app = launch(t, 'invalid');
  const [code] = await app.closed;
  assert.equal(code, 1);
  assert.match(app.output().stderr, /Invalid PORT/);
  assert.doesNotMatch(app.output().stderr, /RangeError|Unhandled/);
});
