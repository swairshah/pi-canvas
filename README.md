# pi-canvas

A lightweight companion input surface for Pi sessions: from a Pi CLI session, run `/canvas`, open the Pi Canvas Home Screen shortcut on any Tailscale-connected iPhone/iPad/browser, draw or pick a photo, tap **Submit**, and the result is delivered back into the requesting Pi session as an image plus local file path.

## MVP implemented here

This repo currently ships as a single Pi extension in `index.ts`.

### Install / run locally

```bash
cd ~/work/projects/pi-canvas
npm install
pi -e ./index.ts
```

Or install as a local Pi package:

```bash
cd ~/work/projects/pi-canvas
pi install .
```

### Commands

```text
/canvas                       create a pending request; device chooses input type
/canvas draw                  open a blank drawing canvas
/canvas photo                 choose/capture a photo and submit it
/canvas annotate              choose/capture a photo, draw over it, submit it
/canvas draw sketch the layout include a prompt shown on the device
/canvas status                show the Home Screen URL and broker status
/canvas open                  open the web UI locally on the Mac
```

### How it works

- Starts one shared HTTP broker on `0.0.0.0:18120` by default.
- Does **not** create or require a token by default; Tailscale is the MVP access boundary.
- Prints a Tailscale URL like `http://100.x.y.z:18120/` from `/canvas status`.
- Save that URL to your iPhone/iPad Home Screen.
- `/canvas` creates a pending request tied to the current Pi process PID.
- Any trusted device that opens the web page can answer the pending request.
- Submitted images are saved under `~/.pi/agent/pi-canvas-media/<pid>/...`.
- The broker writes a JSON result to `~/.pi/agent/pi-canvas-inbox/<pid>/...`.
- The requesting Pi extension watches its inbox and calls `pi.sendUserMessage(...)` with both the image attachment and the local image path.

### Config

```bash
PI_CANVAS_PORT=18120              # default
PI_CANVAS_BIND=0.0.0.0            # default; use 127.0.0.1 for Mac-only testing
PI_CANVAS_TOKEN=...               # optional; only set this if you want token auth
PI_CANVAS_PUBLIC_URL=http://...   # optional URL shown by /canvas status
```

## What exists in PiTalk already

`~/work/projects/pi-talk-app` has the pieces that prove this model works:

- `Extensions/pi-talk/index.ts`
  - registers slash commands with Pi
  - knows the current Pi process PID
  - creates/watches per-session inbox directories at `~/.pi/agent/pitalk-inbox/<pid>`
  - injects incoming text into the current Pi session via `pi.sendMessage(...)`
- `Sources/PiTalk/SendHandler.swift`
  - writes a JSON message into a target Pi session inbox
- `Sources/PiTalk/Remote/PiTalkRemoteRuntime.swift`
  - accepts remote iOS commands
  - saves inbound screenshots under `~/.pi/agent/pitalk-inbox-media/<pid>/...`
  - injects a message into Pi that includes `Image path: ...`
- `apps/pitalk-ios`
  - connects to the Mac over WebSocket/Tailscale
  - lists sessions
  - can send text, push-to-talk transcript, and selected images/screenshots to Pi sessions

For pi-canvas, keep the successful parts but remove the complex parts: no TTS, no speech history, no session timeline, no remote audio, no macOS menu bar app unless later needed.

## Related Pi drawing extensions

Two existing Pi extensions are very close to the local-only version of this idea.

### `mitsuhiko/pi-draw`

Repo: `https://github.com/mitsuhiko/pi-draw`

What it does:

- registers `/draw` and `Ctrl+Shift+C`
- starts a lazy local HTTP server on `127.0.0.1` with a random port
- serves a tldraw page from CDN packages
- exports the current tldraw page to PNG
- writes `/tmp/pi-draw-*.png`
- appends `@/tmp/...png` directly into the current Pi prompt via `ctx.ui.setEditorText(...)`
- keeps the browser canvas open for repeated submissions
- uses a random URL token for local request protection

Useful code ideas:

- single-file Pi extension + embedded web UI is enough for the first version
- `editor.toImage(...)` from tldraw gives clean PNG export
- direct `@path` prompt insertion is excellent when the drawing is for the current interactive prompt
- persistent page state via `persistenceKey` makes repeated submissions nice

Limits for pi-canvas:

- binds only to loopback, so phones cannot reach it until changed to a Tailscale-visible bind
- targets the active local prompt, not a remotely requested/selected Pi session
- no device registry (`iphone`, `ipad`)
- no photo/camera flow besides what tldraw itself supports
- cannot wake/open iOS by itself

### `@ogulcancelik/pi-sketch`

Repo: `https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-sketch`

What it does:

- registers `/sketch`
- starts a temporary local browser canvas server
- serves a custom zero-dependency `<canvas>` UI
- supports draw, colors, brush sizes, undo, clear, resize
- supports clipboard image paste + annotate on top
- Enter submits, Escape cancels
- waits inside Pi with `ctx.ui.custom(...)`
- saves PNGs under `/tmp/pi-sketches/sketch-*.png`
- inserts `Sketch: /path` into the current editor

Useful code ideas:

- very simple custom canvas may be enough and avoids tldraw dependency/CDNs
- clipboard image paste + annotate is exactly the “photo/screenshot then draw on it” interaction
- Pi-side blocking/cancel UI is a good local UX pattern

Limits for pi-canvas:

- also loopback-only
- one-shot request rather than reusable connected device
- no mobile device routing
- no auth beyond local-only
- inserts path into current editor, not async-delivery back to a specific session

### Takeaway from these projects

They strongly support a web-first pi-canvas MVP. The new work is not “how do we draw in a browser?” — both projects solve that. The new work is:

1. expose the drawing server safely over Tailscale;
2. create a device-agnostic `/canvas` request that any trusted browser can answer;
3. handle an async request lifecycle instead of only the active local editor;
4. deliver the submitted image back to the requesting Pi session through an inbox file and `pi.sendUserMessage(...)`;
5. add photo/camera mode and annotation mode.

Best reuse strategy:

- Start from the `pi-draw` shape if you want tldraw/infinite canvas.
- Borrow `pi-sketch`’s custom canvas/paste/annotation ideas if you want a smaller, faster mobile page.
- Do not start by cloning the full PiTalk app; use PiTalk only for session inbox delivery and Tailscale/WebSocket references.

## Key iOS limitation

A Mac on Tailscale cannot silently force-open an iOS app or Safari page on an iPhone/iPad. iOS requires user action unless you use push notifications.

So `/canvas iphone` can realistically do one of these:

1. If the app/page is already open and connected, immediately switch it into drawing mode.
2. If not open, send a push notification/deep link; the user taps it to open the app.
3. Print/show a QR code or URL in Pi; the user opens it manually.

For a first local-only version, option 1 plus a fallback URL/QR is simplest. If “pop open on my phone” is mandatory, build native iOS plus APNs later.

## Options

### Option A — Native iOS app

Best if you want Apple Pencil quality, camera/photo library integration, and eventually push notifications.

Pros:

- Best PencilKit drawing experience via `PKCanvasView`
- Easy camera/photo picker with native permissions
- Can store a device identity such as `iphone` or `ipad`
- Can later receive APNs and open a deep link to a specific canvas request
- Better large-image handling than base64-over-JSON if implemented with multipart upload

Cons:

- Xcode project, signing, provisioning, app deployment
- Custom drawing UI if tldraw-like infinite canvas is desired
- Background WebSockets are unreliable; push is needed for reliable wake/open

Recommended native canvas types:

- `draw`: PencilKit whiteboard, exported as PNG
- `annotate-photo`: pick/take photo, draw over it, exported as PNG/JPEG
- `photo`: camera/photo picker only
- Later: `multi-page` or `pdf-annotate`

### Option B — Web app served from the Mac, using tldraw

Best MVP. Run a local web server on the Mac and open `http://<mac-tailnet>:<port>/r/<requestId>` from iPhone/iPad.

Pros:

- Fastest to build and iterate
- Works on both iPhone and iPad without app signing
- tldraw gives a strong drawing canvas quickly
- Photo upload is easy with browser file/camera inputs
- Pi extension and web server can live in one npm package

Cons:

- Cannot reliably pop open Safari from the Mac
- iOS Safari/PWA push adds HTTPS and install friction
- PencilKit-native feel is better than web canvas
- tldraw may be more UI than needed for a quick sketch

Best web behavior:

- `/canvas iphone` creates a request and, if an `iphone` browser client is connected, sends it a WebSocket event to show the canvas.
- If no client is connected, Pi prints a tailnet URL and QR code.
- Phone submits PNG/JPEG to the Mac server.
- Server saves file locally and injects a message into the requesting Pi session.

### Option C — Reuse PiTalk iOS/mac remote architecture

Best if you want session browsing/control in the canvas app too.

Pros:

- Already has WebSocket protocol, session list, auth token, screenshot delivery, Tailscale flow
- Already writes images to `~/.pi/agent/pitalk-inbox-media/<pid>` and sends image path into Pi

Cons:

- Much more app than pi-canvas needs
- Tied to PiTalk/TTS concepts
- Still does not solve iOS force-open without push

This is useful as reference, not as the base for a simpler pi-canvas MVP.

## Recommendation

Build pi-canvas as a **local Mac broker plus web-first phone/tablet client**, designed to be saved as a Home Screen shortcut/PWA on iPhone and iPad.

This avoids needing the Mac to force-open iOS. The intended flow is:

1. Add `http://<mac-tailnet>:18120/device/iphone` to the iPhone Home Screen.
2. Add `http://<mac-tailnet>:18120/device/ipad` to the iPad Home Screen.
3. When working in Pi, run `/canvas iphone` or `/canvas ipad`.
4. Tap the Home Screen icon on that device if the page is not already open.
5. The page connects to the Mac broker, sees the pending request for that device, and opens the correct input UI automatically.
6. Draw/pick/annotate, tap Submit, and the broker delivers the image back to the requesting Pi session.

Why:

- It matches the simpler goal: image input only.
- It avoids a macOS menu bar app entirely.
- It avoids native iOS signing/provisioning for v1.
- It does not require push notifications or force-opening iOS.
- It can reuse PiTalk’s proven file-inbox delivery model.
- It works over Tailscale with no cloud relay.
- You can later wrap the same protocol in a native iOS app without changing Pi-side delivery.

## Implemented local architecture

```text
Any Pi session with pi-canvas extension
  /canvas [draw|photo|annotate] [prompt]
        │
        ▼
Shared pi-canvas broker on Mac
  - HTTP server on :18120
  - pending request registry
  - media storage under ~/.pi/agent/pi-canvas-media/<pid>/...
  - per-PID inboxes under ~/.pi/agent/pi-canvas-inbox/<pid>/...
        │
        ▼ over Tailscale
Any trusted phone/tablet/browser
  - opens Home Screen shortcut URL
  - sees pending requests
  - draws, submits photo, or annotates photo
        │
        ▼
Mac broker saves image and writes result to the requesting Pi PID's inbox
        │
        ▼
Requesting Pi extension injects a user message with:
  - text containing the local image path
  - inline image attachment when small enough
```

## Minimal HTTP protocol

### Pi creates a request

`POST /api/requests` from the local Pi extension. No token is required by default. If `PI_CANVAS_TOKEN` is set, send it as a bearer token or `?token=...`.

```json
{
  "pid": 12345,
  "cwd": "/Users/swair/work/projects/pi-canvas",
  "project": "pi-canvas",
  "mode": "draw",
  "prompt": "Sketch the layout"
}
```

### Device lists pending requests

`GET /api/requests`

```json
{
  "ok": true,
  "requests": []
}
```

### Device submits

`POST /api/requests/:requestId/submit`

```json
{
  "imageBase64": "...",
  "mimeType": "image/png",
  "note": "optional note"
}
```

The broker returns:

```json
{
  "ok": true,
  "imagePath": "/Users/swair/.pi/agent/pi-canvas-media/12345/abc123.png"
}
```

Then the requesting Pi receives:

```text
Canvas input received. Please inspect and use this image in your answer.
Image path: /Users/swair/.pi/agent/pi-canvas-media/12345/abc123.png
Mode: draw
User note: ...
```

## Later improvements

- QR code in `/canvas` output.
- WebSocket/SSE live refresh instead of polling.
- Optional tldraw mode for infinite canvas/shapes.
- PWA manifest + nicer Home Screen icon.
- Better multiple-session broker persistence across broker owner shutdown.
- Optional native iOS app with PencilKit if the web UI is not enough.
