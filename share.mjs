import { spawn } from 'node:child_process';
import { createChatServer } from './server.mjs';

// Run this explicitly to expose this chat app through a temporary HTTPS tunnel.
const server = createChatServer();
let tunnel;
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  tunnel?.kill();
  server.closeAllConnections();
  server.close();
  process.exitCode = code;
}
server.on('error', error => { console.error(`Could not start Hush: ${error.message}`); shutdown(1); });
server.listen(0, '127.0.0.1', () => {
  const local = `http://127.0.0.1:${server.address().port}`;
  console.log(`Hush started at ${local}`);
  console.log('Starting a temporary public HTTPS address for this chat app. Room access still requires a private invite.');
  console.log('Open the HTTPS URL printed below on BOTH computers. Create a room there, then share its full invite.');
  console.log('Keep this terminal running. Ctrl+C stops the server and tunnel; rooms are held in memory.');
  tunnel = spawn('cloudflared', ['tunnel', '--url', local], { stdio: 'inherit', windowsHide: true });
  tunnel.on('error', error => {
    console.error(error.code === 'ENOENT'
      ? 'cloudflared is not installed or is missing from PATH. Install the official Cloudflare binary: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'
      : `Could not start the tunnel: ${error.message}`);
    shutdown(1);
  });
  tunnel.on('exit', code => { if (!stopping) { console.error('The tunnel closed. Hush is stopping.'); shutdown(code || 1); } });
});
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
