# Verification record — November 24, 2026

## Fixed during the investigation

1. **Persistent connections accumulated across rooms.** The original frontend opened another HTTP/1 SSE stream for each joined room and left earlier streams open. A regression test reproduced three retained streams after visiting three rooms. This can exhaust the browser's per-origin connection allowance and leave sends queued. The browser now uses finite authenticated sync requests with a cursor and timeout. Encryption remains in the browser; the server still relays ciphertext only.
2. **A lost acknowledgement could cause a duplicate on retry.** The frontend now keeps the message ID and encrypted envelope for a retry, and renders the server's acknowledged ciphertext. Concurrent sync and acknowledgement handling deduplicate after decryption as well.
3. **Member rows collapsed on short windows.** Preventing flex shrink on the details panel's children keeps the member list visible, with panel scrolling when needed.
4. **Reopening a saved invite could lose its title.** Reuse the saved room object only after validating its invite secrets. Preserve the current tab's sender IDs across reload and reconnect so earlier messages remain marked as yours.
5. **Concurrent joins could overrun room capacity.** Check capacity after reading the request body and immediately before insertion.

The user's precise original failure could not be uniquely identified without their browser/network state. The retained-stream issue was reproduced locally; direct fresh-session two-user messaging worked before the fix.

## Automated checks

Run `npm ci` then `npm test`. The suite covers:

| Area | Checks |
| --- | --- |
| Encryption | Unicode, wrong key, tampered ciphertext, context binding, fresh IVs |
| Relay | Three users, ciphertext-only responses, finite sync, SSE compatibility, cursor updates, sender acknowledgements |
| Isolation | Separate rooms, incorrect capabilities, sender-session mismatch, wrong invite keys |
| Reliability | Draft retention, offline recovery, session expiry/rejoin, lost acknowledgements, no duplicate retry, reload history |
| Room flows | Creation, joining by invite, reopening a joined invite, search, switching, presence, leave |
| UI logic | Display name, security fingerprint, keyboard sending, navigation controls, safe text rendering |
| Bounds | 200-message history with gap reporting, simultaneous 50-member limit, burst rate limiting |
| Startup | Busy port, free assigned port, invalid port, missing cloudflared cleanup |
| HTTP | Cross-origin rejection, safe static file serving, security headers |

Frontend tests execute the real HTML and `app.js` in independent jsdom windows with real HTTP requests and Web Crypto. No production secrets or personal messages are used.

## Actual browser and internet-route check

- Started `npm run share` using the official cloudflared Windows binary.
- Opened its public HTTPS URL in two independent browser tabs.
- Created the test room as Alice, copied the invitation through the UI, and joined from the second tab as Bob.
- Verified the same Room ID and two members in both sessions.
- Sent Alice → Bob using the send button, then Bob → Alice using Enter. Both decrypted texts appeared in the recipient's conversation.
- Reloaded sessions and verified recent history and subsequent sends.
- Checked desktop at 1280×720 and mobile at 390×844, including the mobile member panel. The mobile document width equalled the viewport width (no horizontal overflow).
- Sent a message from the mobile layout and verified it in the desktop session.
- Saved desktop and mobile screenshots of the test conversation. The temporary tunnel was used only for this test and is not permanent hosting.

## Limits of verification

This confirms independent browser sessions communicating through a public HTTPS relay, not two physical computers on every possible network. Device-specific firewall, browser, proxy, and clipboard restrictions still need validation on the intended computers. The optional Render configuration has not been deployed. This research prototype retains room state only in memory and has no forward secrecy or identity verification; see the README for its security model.
