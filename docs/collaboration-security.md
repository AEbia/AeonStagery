# Collaboration server security

## Network access

The embedded collaboration server uses plain HTTP and WebSocket (`ws://`). Disabling
the network option binds it to loopback. Enabling it binds `0.0.0.0`, which listens
on every IPv4 interface; a public interface or router port forwarding can make the
server reachable from the public internet. The host firewall and router determine
which remote addresses can connect.

By default, HTTP and WebSocket origins allow the desktop app's file origins
(`null` for HTTP, `file://` for WebSocket) and local HTTP development renderers on
`localhost`, `127.0.0.0/8`, or `[::1]`, on any port. Each peer can run Vite on a different local port, such as
5173 and 5174. Other web origins are rejected. An explicit `allowedOrigins` list
(or `AEONSTAGERY_COLLAB_ORIGINS` for the standalone server) replaces this default
with exact origin matching. The embedded server uses the default for local
renderers and an explicit list for a custom non-local renderer origin.

The server's invitation URLs use `http://`. The invite credential remains in the
URL fragment and is not sent as part of the HTTP request. Remote HTTP and WebSocket
requests authenticate with a short-lived, single-use HMAC proof tied to the source
address, request method, and request path. The bearer secret itself is only sent to
the loopback server. This prevents passive observers from replaying a captured
long-lived bearer credential, but it does not encrypt collaboration data or protect
against an active on-path attacker.

Use direct collaboration connections only on networks you trust. For untrusted or
public networks, put the service behind a TLS-terminating reverse proxy, forward
WebSocket upgrades, and block direct access to the embedded server port so clients
cannot bypass TLS.

## Authentication limits

The host derives a PBKDF2-SHA-256 token from a custom room password and a random
per-session salt. A joining client receives the salt and derives the same token
locally; the typed password is not sent over the network. A captured HMAC proof can
still support offline guessing of a weak custom password, so choose a strong room
password. The automatically generated room password has 96 bits of random entropy.
Remote authentication challenges expire after 30 seconds and can be used once.
Five failed credential proofs from one source address within a minute block further
authentication from that address for one minute. The limiter is in memory and its
tracked-address table is bounded; it is an online guessing control, not account
lockout or distributed rate limiting.

Loopback clients retain the local bearer-token path for compatibility. Do not expose
the embedded port directly to the internet. A TLS-terminating proxy should also
strip any incoming `Authorization` header before forwarding requests.
