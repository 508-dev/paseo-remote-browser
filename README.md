# Paseo remote browser

Two interactive browser prototypes using Paseo's existing encrypted connection. Neither opens an inbound port on the host or changes the relay.

|                              | Stream the host browser                               | Forward a dev site                                                 |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Browser runs on              | The Paseo host                                        | Your viewing computer                                              |
| Interaction                  | Pointer, keyboard and gestures sent to Chrome         | Normal local browser interaction                                   |
| Cookies and network identity | Host browser context, isolated per workspace          | Local browser profile and local origin                             |
| Use when                     | You need the host's browser session or network access | You want a responsive dev preview, including WebSocket/HMR traffic |
| Entry point                  | **Host browser** workspace panel                      | `npm run forward` on the viewing computer                          |

## Stream the host browser

Requires Paseo 0.16.0-beta.1 or newer on both host and client, Node 22+, and Chrome or Chromium installed on the host. If Chrome is not in its standard location, set `PASEO_BROWSER_EXECUTABLE` in the daemon environment. `puppeteer-core` does not download a browser.

```sh
paseo plugin install git:508-dev/paseo-remote-browser
```

Enable **Remote browser** in Paseo's plugin settings and open **Host browser** in a workspace or from Command Center. Navigate to `localhost:3000` to inspect a server on the selected host.

On web and desktop, click the page to focus it, then type, paste, scroll or drag directly. Keyboard down/up events preserve modifiers. Native clients have tap-to-click, swipe-to-scroll, a drag mode and a keyboard field that sends edits as you type. Native device and IME behavior still need verification.

Chrome pushes JPEG screencast frames through binary plugin subscriptions. Each viewer acknowledges a frame after its image loads; the host retains at most one outstanding image and the newest pending image. Capture runs independently of input, so actions no longer wait for a screenshot. The stream is capped around 15 frames/second before network and decode costs. It pauses delivery behind a slow viewer rather than queuing old frames. Reconnect creates a fresh stream.

The viewport is fixed at 1024 × 768. This is an interactive page stream, without audio, native browser chrome, file picker/download integration, or remote-to-local clipboard synchronization. JavaScript dialogs are dismissed. Popups become the active page. Cookies stay in the workspace context while the plugin runs; restarting the plugin resets it. Archiving the workspace releases its browser, viewers and tunnels.

[Desktop capture](docs/screenshots/streamed-desktop.png) · [Compact dark web capture](docs/screenshots/streamed-compact-dark.png)

## Forward a dev site

This prototype runs a small Node companion **on the viewing computer**. Its loopback listener forwards TCP bytes through plugin subscriptions and binary RPCs to `127.0.0.1:<selected port>` on the Paseo host. Each browser connection owns a separate tunnel. HTTP, WebSocket upgrades, HMR, SSE, uploads and streaming responses use the same path; there is no HTML or JavaScript rewriting.

Install the plugin on the host, then check out this repository on the viewing computer and prepare its locked dependencies:

```sh
npm ci --include=dev --ignore-scripts --legacy-peer-deps --min-release-age=7
```

Set these environment variables before starting the companion:

| Variable                    | Meaning                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_BROWSER_HOST`        | Paseo SDK host target: direct `host:port`, SSH target, or your paired `relay://` URI. Keep credential-bearing targets out of shell history and logs. |
| `PASEO_BROWSER_WORKSPACE`   | An existing workspace ID on that host                                                                                                                |
| `PASEO_BROWSER_REMOTE_PORT` | Host loopback TCP port, default `3000`                                                                                                               |
| `PASEO_BROWSER_LOCAL_PORT`  | Viewing computer's loopback port, default `0` (choose an available port)                                                                             |

```sh
npm run forward
```

Open the printed `http://127.0.0.1:<port>` URL in your browser. Stop with Ctrl+C. A paired relay target uses Paseo's existing endpoint encryption; direct targets use their configured connection security. The companion never prints the target or tunnel capabilities.

The tunnel is limited to host IPv4 loopback, 64 simultaneous sockets, 64 KiB chunks and a 256 KiB read window per socket. Credits return after the local socket consumes each chunk; uploads wait for upstream writes. Disconnect, subscription release, archive and plugin shutdown close the corresponding sockets. Idle sockets expire after 60 seconds. Existing TCP connections cannot survive a Paseo disconnect; reload the page after restarting the companion.

This preserves a site's bytes, including its original `Host` header, redirects and cookies. Sites that hardcode upstream origins/ports, domain-scoped cookies, HTTPS certificates or strict origin checks may need dev-server configuration. The endpoint is a local dev origin, not the host browser's profile. An authorized plugin client can select any host loopback port; forwarding is not restricted to workspace scripts.

**Phone integration is not implemented:** the companion requires Node on the viewing computer. Embedding this approach in Paseo's iOS/Android WebView needs an app-owned native loopback bridge or an authenticated HTTP gateway. This prototype verifies the forwarding transport and browser behavior before adding that app integration.

[Local browser capture](docs/screenshots/forwarded-browser.png)

## Development and verification

```sh
npm ci --include=dev --ignore-scripts --legacy-peer-deps --min-release-age=7
npm run typecheck
npm run lint
npm run format:check
npm run test -- server/browser.test.ts server/tunnel.test.ts
```

Set `PASEO_BROWSER_INTEGRATION=1` to run the Chrome integration cases in `server/browser.test.ts`; otherwise those cases are skipped. The tests exercise live changing frames and viewer credits, direct typing and dragging without screenshots, streamed HTTP, cookies/redirects, binary uploads, WebSocket upgrades, refused ports and socket teardown.

The prototypes were also checked through an isolated Paseo daemon with the real plugin compiler, subprocess, binary RPCs and subscriptions. The compiled React Native Web panel was exercised in Chrome at desktop and compact widths. iOS, Android, non-Linux desktop platforms and the production relay have not been exercised.
