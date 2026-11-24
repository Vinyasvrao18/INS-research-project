import { randomSecret, importRoomKey, encrypt, decrypt, parseInvite, decode } from './crypto.js';

const $ = selector => document.querySelector(selector);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const element = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
const storage = { get(key, fallback) { try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; } }, set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} } };
let displayName = storage.get('hush-name', `Guest ${Math.floor(1000 + Math.random() * 9000)}`);
let rooms = storage.get('hush-rooms', []).filter(r => r.id && r.secret && r.access);
let active = null;
let dialogAction;
let toastTimer;
let switching = false;
let sending = false;
const sessions = new Map();
const save = () => storage.set('hush-rooms', rooms.map(({ id, secret, access, name, ownIds }) => ({ id, secret, access, name, ownIds })));
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function profileUI() { $('#my-name').textContent = displayName; $('#my-avatar').textContent = displayName.slice(0, 2).toUpperCase(); }
async function api(path, token, body, method = 'POST', signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 10000);
  try {
    const response = await fetch(path, { method, signal: controller.signal, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Connection failed. Please try again.'), { status: response.status });
    return data;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error('The server took too long to respond. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
function inviteURL(room = active?.room) {
  if (!room) throw new Error('Choose a room first.');
  const url = new URL('/', location.origin);
  url.hash = new URLSearchParams({ room: room.id, key: room.secret, access: room.access }).toString();
  return url.href;
}
function renderRooms() {
  const list = $('#room-list'); list.replaceChildren();
  $('#room-count').textContent = rooms.length;
  const filter = $('#room-search').value.toLowerCase();
  for (const room of rooms.filter(r => (r.name || 'Private room').toLowerCase().includes(filter))) {
    const button = element('button', `room-item${active?.room.id === room.id ? ' active' : ''}`);
    const image = element('span', 'list-icon'); image.innerHTML = icon('chat');
    const label = element('span', ''); label.append(element('strong', '', room.name || 'Private room'), element('small', '', 'End-to-end encrypted'));
    button.append(image, label);
    if (sessions.get(room.id)?.unread) button.append(element('span', 'unread'));
    if (active?.room.id === room.id) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => activate(room).catch(showError)); list.append(button);
  }
  if (!list.childElementCount) list.append(element('p', 'no-results', filter ? 'No matching rooms.' : 'Your next conversation starts here.'));
}
function status(session, connected) {
  if (!session) return;
  session.connected = connected;
  if (session !== active) return;
  $('#connection-dot').classList.toggle('connected', connected);
  $('#connection-status').textContent = connected ? `${session.members.length || 1} online` : 'Reconnecting…';
  $('#message-input').disabled = !connected;
  $('#send').disabled = !connected || !$('#message-input').value.trim() || sending;
}
function showError(error) { $('#connection-error').hidden = false; $('#connection-error span').textContent = error.message; }
function renderMembers(session) {
  if (session !== active) return;
  const container = $('#members'); container.replaceChildren();
  $('#member-count').textContent = session.members.length;
  for (const member of session.members) {
    const row = element('div', 'member');
    row.append(element('span', `avatar${member.id === session.id ? ' me' : ''}`, member.name.slice(0, 2).toUpperCase()));
    const text = element('span', ''); text.append(element('strong', '', member.name + (member.id === session.id ? ' (you)' : '')), element('small', '', 'Here now'));
    row.append(text, element('span', 'online')); container.append(row);
  }
  status(session, session.connected);
}
function renderMessage(message, session) {
  const mine = session.ownIds.has(message.sender);
  const row = element('article', `message-row${mine ? ' mine' : ''}`);
  row.append(element('span', `avatar${mine ? ' me' : ''}`, message.name.slice(0, 2).toUpperCase()));
  const content = element('div', 'message-content');
  const meta = element('div', 'message-meta');
  meta.append(element('strong', '', mine ? `${message.name} · you` : message.name), element('time', '', new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  content.append(meta, element('div', 'message-bubble', message.text));
  if (mine) content.append(element('span', 'message-status', '✓ Relayed · encrypted'));
  row.append(content); $('#messages').append(row);
}
function renderConversation(session) {
  $('#messages').replaceChildren(); $('#welcome').hidden = session.messages.length > 0;
  for (const message of session.messages) renderMessage(message, session);
  $('#conversation').scrollTop = $('#conversation').scrollHeight;
}
async function receiveMessage(session, message, render = true) {
  if (session.seen.has(message.id)) return;
  try {
    const body = await decrypt(session.key, message.payload, `${session.room.id}:message:${message.sender}:${message.id}`);
    const profile = await decrypt(session.key, message.profile, `${session.room.id}:profile:${message.sender}`);
    if (typeof body.text !== 'string' || body.text.length > 4000 || typeof profile.name !== 'string') throw new Error('Invalid message');
    const parsed = { ...message, name: profile.name.slice(0, 32), text: body.text };
    // A send acknowledgement and a sync response can decrypt the same message concurrently.
    if (session.seen.has(message.id)) return;
    session.seen.add(message.id); session.messages.push(parsed);
    session.messages.sort((a, b) => a.sequence - b.sequence);
    if (session.messages.length > 200) session.messages.shift();
    if (render && session === active) renderConversation(session);
    else if (render) { session.unread = true; renderRooms(); }
  } catch { if (session === active) toast('A message could not be verified and was not displayed.'); }
}
async function handleEvent(session, type, data) {
  if (type === 'history') {
    for (const message of data) await receiveMessage(session, message, false);
    if (session === active) renderConversation(session);
  }
  if (type === 'message') await receiveMessage(session, data);
  if (type === 'presence') {
    const members = [];
    for (const member of data) {
      try { const profile = await decrypt(session.key, member.profile, `${session.room.id}:profile:${member.id}`); members.push({ id: member.id, name: String(profile.name).slice(0, 32) }); } catch { /* Do not display unverifiable profiles. */ }
    }
    session.members = members; renderMembers(session);
  }
}
async function connect(session) {
  let attempts = 0;
  while (!session.stopped) {
    const abort = new AbortController(); session.abort = abort;
    try {
      // Finite requests avoid HTTP/1 stream limits and proxies that buffer SSE.
      const update = await api(`/api/rooms/${session.room.id}/sync?after=${session.cursor}`, session.token, null, 'GET', abort.signal);
      if (session.stopped) break;
      for (const message of update.messages) await receiveMessage(session, message, false);
      session.cursor = update.cursor;
      await handleEvent(session, 'presence', update.members);
      if (update.messages.length) {
        if (session === active) renderConversation(session);
        else { session.unread = true; renderRooms(); }
      }
      if (update.historyGap && session === active) toast('Some older messages expired while you were offline. Showing the recent history.');
      status(session, true); attempts = 0;
      if (session === active) $('#connection-error').hidden = true;
    } catch (error) {
      if (session.stopped) break;
      status(session, false);
      if (error.status === 401) {
        try { await rejoin(session); continue; } catch (joinError) { error = joinError; }
      }
      if ([403, 404].includes(error.status)) {
        session.started = false;
        if (session === active) showError(error);
        break;
      }
      attempts++;
      if (session === active) showError(new Error('Connection interrupted. Your draft is safe; reconnecting…'));
    }
    if (session.stopped) break;
    const delay = attempts ? Math.min(1000 * 2 ** (attempts - 1), 10000) : session === active ? 750 : 2500;
    await new Promise(resolve => { session.retryTimer = setTimeout(resolve, delay); session.wake = resolve; });
  }
}
async function rejoin(session) {
  const id = crypto.randomUUID();
  const profile = await encrypt(session.key, { name: session.name }, `${session.room.id}:profile:${id}`);
  const result = await api(`/api/rooms/${session.room.id}/join`, session.room.access, { id, profile });
  session.id = id; session.token = result.memberToken; session.ownIds.add(id);
  session.room.ownIds = [...session.ownIds]; save();
}
async function activate(room) {
  if (switching) return;
  switching = true;
  if (active) active.draft = $('#message-input').value;
  try {
    let session = sessions.get(room.id);
    if (session) {
      if (room.secret !== session.room.secret || room.access !== session.room.access) throw new Error('This invite does not match the saved room key.');
      room = session.room;
    } else {
      room = rooms.find(saved => saved.id === room.id && saved.secret === room.secret && saved.access === room.access) || room;
    }
    if (!session) {
      const key = await importRoomKey(room.secret);
      const id = crypto.randomUUID();
      const profile = await encrypt(key, { name: displayName }, `${room.id}:profile:${id}`);
      const result = await api(`/api/rooms/${room.id}/join`, room.access, { id, profile });
      try {
        const metadata = await decrypt(key, result.metadata, `${room.id}:metadata`);
        room.name = String(metadata.name).slice(0, 50);
      } catch (error) {
        await api(`/api/rooms/${room.id}/leave`, result.memberToken).catch(() => {});
        throw new Error('The room key could not unlock this room. Check your invite link.');
      }
      const ownIds = new Set([...(Array.isArray(room.ownIds) ? room.ownIds : []), id]);
      room.ownIds = [...ownIds];
      session = { room, key, id, name: displayName, ownIds, token: result.memberToken, cursor: 0, members: [], messages: [], seen: new Set(), connected: false, stopped: false, draft: '' };
      sessions.set(room.id, session);
    }
    active = session; session.unread = false;
    if (!rooms.some(r => r.id === room.id)) rooms.push(room);
    save(); storage.set('hush-active', room.id);
    history.replaceState(null, '', '/');
    $('#room-title').textContent = room.name; $('#details-name').textContent = room.name;
    $('#room-code').textContent = `Room ${room.id.slice(0, 8)}`;
    document.title = `${room.name} · Hush`;
    $('#message-input').value = session.draft;
    $('#connection-error').hidden = true;
    renderRooms(); renderConversation(session); renderMembers(session); status(session, session.connected);
    $('.app').classList.remove('show-sidebar');
    if (!session.started) { session.started = true; session.run = connect(session); }
  } finally { switching = false; }
}
async function createRoom(name) {
  const room = { id: crypto.randomUUID(), secret: randomSecret(), access: randomSecret(), name };
  const key = await importRoomKey(room.secret);
  const metadata = await encrypt(key, { name }, `${room.id}:metadata`);
  await api('/api/rooms', null, { id: room.id, accessToken: room.access, metadata });
  await activate(room);
}
function field(label, name, value = '', placeholder = '', multiline = false) {
  const wrapper = element('label', '', label); const input = document.createElement(multiline ? 'textarea' : 'input');
  input.name = name; input.value = value; input.placeholder = placeholder; input.required = true; input.autocomplete = 'off';
  if (!multiline) input.maxLength = name === 'name' ? 32 : 50;
  wrapper.append(input); return wrapper;
}
function openDialog(title, description, fields, submit, action) {
  $('#dialog-title').textContent = title; $('#dialog-description').textContent = description;
  $('#dialog-fields').replaceChildren(...fields); $('#dialog-submit').textContent = submit; $('#dialog-submit').disabled = false;
  $('#dialog-error').textContent = ''; dialogAction = action; $('#dialog').showModal();
}
function createDialog() {
  openDialog('Make a little space.', 'A private room for your people. Give it a name, then share the invite.', [field('Room name', 'room', '', 'e.g. The weekend crew')], 'Create private room', async data => { const name = data.get('room').trim(); if (!name) throw new Error('Give your room a name.'); await createRoom(name); toast('Your room is ready. Invite your people.'); return true; });
}
function joinDialog(invite = '') {
  openDialog('Good company awaits.', 'Paste the full invite link. The private key stays on your device.', [field('Your name', 'name', displayName), field('Private invite link', 'invite', invite, 'https://…/#room=…&key=…&access=…', true)], 'Join the conversation', async data => {
    const name = data.get('name').trim(); if (!name) throw new Error('Enter a display name.');
    const input = data.get('invite').trim(); const url = new URL(input);
    if (url.origin !== location.origin) throw new Error('This invite belongs to another server. Open the original invite link in your browser.');
    const room = parseInvite(input); displayName = name; storage.set('hush-name', name); profileUI(); await activate(room); return true;
  });
}
function inviteDialog() {
  if (!active) return toast('Create or join a room first.');
  const input = field('Private invite link', 'invite', inviteURL(), '', true); input.querySelector('textarea').readOnly = true;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const description = local
    ? 'This localhost link works only on this computer. To chat across computers, open Hush through a shared HTTPS address first, then copy its invite. Anyone with the full invite can read recent messages.'
    : 'Anyone with this full link can join this exact room and read recent messages. Share it privately. Creating a separate room with the same name will not connect you.';
  openDialog('Good things are shared.', description, [input], 'Copy invite link', async () => {
    try { await navigator.clipboard.writeText(inviteURL()); toast('Invite copied. Send it to your people.'); return true; }
    catch { input.querySelector('textarea').select(); throw new Error('Select and copy the invite link above.'); }
  });
}
async function securityDialog() {
  const details = element('p', 'security-text', 'Messages, display names, and room names use AES-256-GCM encryption in your browser. The server relays encrypted data to room members. It can see connection information and message timing, but does not receive the room key.');
  const limits = element('p', 'security-text', 'Everyone with the invite shares the same key and can read recent history. Names are self-chosen, not verified identities. This prototype does not provide forward secrecy. For a fresh key, create a new room.');
  const fields = [details, limits];
  if (active) {
    const hash = await crypto.subtle.digest('SHA-256', decode(active.room.secret));
    fields.push(element('p', 'security-text', 'Compare this key fingerprint with your friends over a trusted channel:'), element('code', '', [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').match(/.{1,4}/g).join(' ')));
  }
  openDialog('Private by design.', 'Your message takes a trip. Its key stays with you.', fields, 'Got it', async () => true);
}
async function pauseSession(session) {
  session.stopped = true; session.abort?.abort(); clearTimeout(session.retryTimer); session.wake?.();
  await session.run;
}
async function stopSession(session) {
  await pauseSession(session);
  await api(`/api/rooms/${session.room.id}/leave`, session.token).catch(() => {});
  sessions.delete(session.room.id);
}
$('#dialog-close').onclick = () => $('#dialog').close();
$('#dialog-form').onsubmit = async event => {
  event.preventDefault(); $('#dialog-error').textContent = ''; $('#dialog-submit').disabled = true;
  try { if (await dialogAction(new FormData(event.currentTarget))) $('#dialog').close(); }
  catch (error) { $('#dialog-error').textContent = error.message; }
  finally { $('#dialog-submit').disabled = false; }
};
document.querySelectorAll('.new-room').forEach(button => button.onclick = createDialog);
$('#join-room').onclick = () => joinDialog();
for (const id of ['invite', 'welcome-invite', 'add-people']) $(`#${id}`).onclick = inviteDialog;
for (const id of ['privacy-info', 'banner-info', 'security-details']) $(`#${id}`).onclick = () => securityDialog().catch(showError);
$('#room-search').oninput = renderRooms;
$('#edit-profile').onclick = () => openDialog('What should we call you?', 'Your new name will appear when you join or create your next room.', [field('Display name', 'name', displayName)], 'Save name', async data => { const name = data.get('name').trim(); if (!name) throw new Error('Enter your name.'); displayName = name; storage.set('hush-name', name); profileUI(); toast('Name saved for your next room.'); return true; });
$('#message-input').oninput = () => { $('#send').disabled = !active?.connected || !$('#message-input').value.trim() || sending; };
$('#message-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('#send').disabled) $('#message-form').requestSubmit(); } };
$('#message-form').onsubmit = async event => {
  event.preventDefault(); const session = active; const original = $('#message-input').value; const text = original.trim();
  if (!session?.connected || !text || sending) return;
  sending = true; $('#send').disabled = true;
  try {
    // Keep the same encrypted envelope on retry, including when an acknowledgement was lost.
    if (!session.pending || session.pending.text !== text || session.pending.sender !== session.id) {
      const id = crypto.randomUUID();
      const sender = session.id;
      const payload = await encrypt(session.key, { text }, `${session.room.id}:message:${sender}:${id}`);
      session.pending = { text, id, sender, payload };
    }
    const { id, sender, payload } = session.pending;
    const result = await api(`/api/rooms/${session.room.id}/messages`, session.token, { id, sender, payload });
    if (result.message) await receiveMessage(session, result.message);
    session.pending = null;
    if (active === session && $('#message-input').value === original) $('#message-input').value = '';
    session.draft = '';
  } catch (error) { toast(error.message); }
  finally { sending = false; status(active, active?.connected); if (active === session) $('#message-input').focus(); }
};
$('#reconnect').onclick = async () => {
  try {
    if (active) {
      const session = active;
      await pauseSession(session);
      session.stopped = false; session.started = true; session.run = connect(session);
    } else await boot();
  } catch (error) { showError(error); }
};
$('#leave-room').onclick = () => {
  if (!active) return;
  const session = active;
  openDialog('Leave this little space?', 'This removes the room and its key from this tab. You’ll need the invite link to return. Other people can keep chatting.', [], 'Leave room', async () => {
    await stopSession(session); rooms = rooms.filter(r => r.id !== session.room.id); save(); active = null;
    if (rooms.length) await activate(rooms[0]); else await createRoom('The common room');
    toast('You left the room.'); return true;
  });
};
$('#menu').onclick = () => $('.app').classList.toggle('show-sidebar');
$('.main').addEventListener('click', event => { if (!event.target.closest('#menu')) $('.app').classList.remove('show-sidebar'); });
$('#details-toggle').onclick = () => { if (matchMedia('(max-width:1150px)').matches) $('.app').classList.toggle('show-details'); else $('.app').classList.toggle('details-hidden'); };
$('#close-details').onclick = () => { $('.app').classList.remove('show-details'); if (!matchMedia('(max-width:1150px)').matches) $('.app').classList.add('details-hidden'); };
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !$('#dialog').open) { event.preventDefault(); $('.app').classList.add('show-sidebar'); $('#room-search').focus(); } });
window.addEventListener('pagehide', () => { for (const session of sessions.values()) { session.stopped = true; session.abort?.abort(); clearTimeout(session.retryTimer); session.wake?.(); fetch(`/api/rooms/${session.room.id}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` }, keepalive: true }).catch(() => {}); } });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function boot() {
  profileUI(); renderRooms();
  if (!globalThis.crypto?.subtle) throw new Error('Encryption needs HTTPS or localhost. Open this app over a secure connection.');
  $('#today-label').textContent = new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase() + ' · TODAY';
  if (location.hash) {
    const invite = location.href; parseInvite(invite); joinDialog(invite); return;
  }
  const previous = storage.get('hush-active', null);
  if (rooms.length) await activate(rooms.find(r => r.id === previous) || rooms[0]);
  else await createRoom('The common room');
}
boot().catch(showError);
