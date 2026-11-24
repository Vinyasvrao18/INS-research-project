const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid invite key.');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export const randomSecret = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export async function importRoomKey(secret) {
  const bytes = decode(secret);
  if (bytes.length !== 32) throw new Error('Invalid room key.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(key, data, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(JSON.stringify(data)));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function decrypt(key, envelope, context) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv), additionalData: encoder.encode(context) }, key, decode(envelope.ciphertext));
  return JSON.parse(decoder.decode(plain));
}
export function parseInvite(value) {
  const url = new URL(value);
  const p = new URLSearchParams(url.hash.slice(1));
  const room = { id: p.get('room'), secret: p.get('key'), access: p.get('access') };
  if (!/^[0-9a-f-]{36}$/i.test(room.id || '') || decode(room.secret).length !== 32 || decode(room.access).length !== 32) throw new Error('This invite is incomplete. Copy the full private invite link.');
  return room;
}
