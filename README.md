# pi-canvas

Use your phone or tablet as a drawing/photo input for [Pi](https://pi.dev).

Run `/canvas` in any Pi session, open the Pi Canvas page on your iPhone or iPad over Tailscale, draw something or pick a photo, hit **send**, and it shows up in your Pi conversation — image and all.

| iPhone canvas | Pi receives the drawing |
|---|---|
| <img src="docs/iphone-canvas.png" alt="Drawing on iPhone" width="280" /> | <img src="docs/pi-receiving-canvas.png" alt="Pi receiving the canvas image" width="100%" /> |

## Install

```bash
pi install https://github.com/swairshah/pi-canvas
```

Or from a local checkout:

```bash
cd pi-canvas
pi install .
```

## Setup

Your Mac and phone/tablet need to be on the same [Tailscale](https://tailscale.com) network.

1. Start a Pi session (the extension loads automatically).
2. Run `/canvas status` — it prints your Canvas URL, something like:

   ```
   http://100.119.70.61:18120/
   ```

3. Open that URL on your iPhone/iPad in Safari.
4. **Save it to your Home Screen** — now you have a one-tap shortcut.

That's it. The URL stays the same across Pi sessions.

## Usage

In Pi, run:

```
/canvas
```

Then open the Pi Canvas shortcut on your phone. You'll see the pending request — tap **Open**, draw or pick a photo, and tap **send**.

The drawing is delivered directly into your Pi conversation as an inline image with the local file path, so the model can see and reason about it.

### Modes

```
/canvas                            let the device choose (draw / photo / annotate)
/canvas draw                       open a blank drawing canvas
/canvas photo                      pick or capture a photo
/canvas annotate                   pick a photo, then draw on top of it
/canvas draw sketch the layout     include a prompt shown on the device
```

### Other commands

```
/canvas status     show the Home Screen URL and broker info
/canvas open       open the canvas page locally on your Mac
```

## How it works

- The extension starts a small HTTP server on your Mac (port `18120`, bound to `0.0.0.0`).
- `/canvas` creates a pending request tied to your current Pi session.
- Any device on your Tailscale network can open the page, claim the request, and submit.
- Submitted images are saved locally under `~/.pi/agent/pi-canvas-media/`.
- The image is injected back into the requesting Pi session as a user message with both the image attachment and the file path.
- No tokens, no cloud, no accounts. Just Tailscale.

## Input modes

**Draw** — freehand canvas with colors (black, red, green, blue, white/eraser), brush sizes (S/M/L), undo, and clear. Works great with finger or Apple Pencil.

**Photo** — pick from your photo library or take a picture with the camera.

**Annotate** — pick a photo first, then draw annotations on top of it before submitting.

All modes include an optional note field you can type into before sending.

## Config (optional)

```bash
PI_CANVAS_PORT=18120              # default port
PI_CANVAS_BIND=0.0.0.0            # default; use 127.0.0.1 for Mac-only
PI_CANVAS_TOKEN=mysecret          # optional token auth (off by default)
PI_CANVAS_PUBLIC_URL=http://...   # override the URL shown by /canvas status
```

## License

MIT
