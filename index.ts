import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces, homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "node:fs";

const DEFAULT_PORT = 18120;
const DEFAULT_BIND = "0.0.0.0";
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_INLINE_BYTES = 8 * 1024 * 1024;
const REQUEST_TTL_MS = 60 * 60 * 1000;
const POLL_MS = 1200;

type CanvasMode = "auto" | "draw" | "photo" | "annotate";
type CanvasRequestStatus = "pending" | "claimed" | "submitted" | "cancelled";

type CanvasRequest = {
  id: string;
  pid: number;
  cwd: string;
  project: string;
  mode: CanvasMode;
  prompt?: string;
  createdAt: number;
  updatedAt: number;
  status: CanvasRequestStatus;
  claimedBy?: string;
};

type CreateRequestBody = {
  pid: number;
  cwd: string;
  project: string;
  mode: CanvasMode;
  prompt?: string;
};

type SubmitRequestBody = {
  imageBase64: string;
  mimeType: string;
  note?: string;
  deviceName?: string;
};

type InboxMessage = {
  type: "canvas_result";
  requestId: string;
  imagePath: string;
  mimeType: string;
  note?: string;
  prompt?: string;
  mode: CanvasMode;
  project?: string;
  from?: string;
  timestamp: string;
};

type BrokerStartResult = {
  role: "server" | "client";
  baseUrl: string;
  token: string;
};

const stateDir = join(homedir(), ".pi", "agent", "pi-canvas");
const inboxBaseDir = join(homedir(), ".pi", "agent", "pi-canvas-inbox");
const mediaBaseDir = join(homedir(), ".pi", "agent", "pi-canvas-media");

function envPort(): number {
  const raw = process.env.PI_CANVAS_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

function envBind(): string {
  return process.env.PI_CANVAS_BIND || DEFAULT_BIND;
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function getConfiguredToken(): string {
  // No token by default. Tailscale is the intended access boundary for the MVP.
  // Set PI_CANVAS_TOKEN only if you explicitly want URL/bearer-token auth.
  return process.env.PI_CANVAS_TOKEN?.trim() || "";
}

function projectNameForCwd(cwd: string): string {
  return basename(cwd) || "pi";
}

function normalizeMode(value: string | undefined): CanvasMode | undefined {
  const mode = value?.trim().toLowerCase();
  if (mode === "draw" || mode === "photo" || mode === "annotate" || mode === "auto") return mode;
  return undefined;
}

function parseCanvasArgs(args: string | undefined): { mode: CanvasMode; prompt?: string; special?: "status" | "open" } {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return { mode: "auto" };

  const [first, ...rest] = trimmed.split(/\s+/);
  if (first === "status") return { mode: "auto", special: "status" };
  if (first === "open") return { mode: "auto", special: "open" };

  const mode = normalizeMode(first);
  if (mode) {
    const prompt = rest.join(" ").trim();
    return { mode, prompt: prompt || undefined };
  }

  return { mode: "auto", prompt: trimmed };
}

function isAuthorized(req: IncomingMessage, token: string, url: URL): boolean {
  if (!token) return true;

  const queryToken = url.searchParams.get("token");
  if (queryToken === token) return true;

  const auth = req.headers.authorization;
  if (auth === `Bearer ${token}`) return true;

  return false;
}

function writeHtml(res: ServerResponse, html: string) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  res.end(html);
}

function writeText(res: ServerResponse, statusCode: number, text: string) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  res.end(text);
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  res.end(JSON.stringify(value));
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function getHttpStatus(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error) {
    const statusCode = Number((error as { statusCode: unknown }).statusCode);
    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) return statusCode;
  }
  return 500;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw httpError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage, maxBytes = MAX_JSON_BYTES): Promise<T> {
  const body = await readBody(req, maxBytes);
  if (body.length === 0) throw httpError(400, "Missing JSON body.");
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw httpError(400, "Invalid JSON body.");
  }
}

function mimeToExt(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("heic")) return "heic";
  return "jpg";
}

function safeBase64ToBuffer(imageBase64: string): Buffer {
  const cleaned = imageBase64.includes(",") ? imageBase64.split(",").pop() ?? "" : imageBase64;
  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.length === 0) throw httpError(400, "Image is empty or invalid.");
  return buffer;
}

function writeInboxMessage(pid: number, message: InboxMessage) {
  const inboxDir = join(inboxBaseDir, String(pid));
  ensureDir(inboxDir);
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  writeFileSync(join(inboxDir, filename), JSON.stringify(message, null, 2));
}

function persistSubmittedImage(request: CanvasRequest, body: SubmitRequestBody): { imagePath: string; bytes: number } {
  const imageData = safeBase64ToBuffer(body.imageBase64);
  if (imageData.length > MAX_JSON_BYTES) throw httpError(413, "Image upload is too large.");

  const ext = mimeToExt(body.mimeType);
  const dir = join(mediaBaseDir, String(request.pid));
  ensureDir(dir);
  const imagePath = join(dir, `${Date.now()}-${request.id}.${ext}`);
  writeFileSync(imagePath, imageData, { mode: 0o600 });
  return { imagePath, bytes: imageData.length };
}

function cleanupExpiredRequests(requests: Map<string, CanvasRequest>) {
  const now = Date.now();
  for (const [id, request] of requests) {
    if (request.status !== "pending" && request.status !== "claimed") continue;
    if (now - request.createdAt > REQUEST_TTL_MS) requests.delete(id);
  }
}

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : response.statusText;
    throw new Error(message);
  }
  return payload as T;
}

function withOptionalToken(url: string, token: string): string {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function getTailnetOrLocalUrl(port: number, token: string): string {
  if (process.env.PI_CANVAS_PUBLIC_URL?.trim()) {
    const publicUrl = process.env.PI_CANVAS_PUBLIC_URL.trim().replace(/\/$/, "");
    return withOptionalToken(`${publicUrl}/`, token);
  }

  const tailscaleIp = findTailscaleIp();
  if (tailscaleIp) return withOptionalToken(`http://${tailscaleIp}:${port}/`, token);

  return withOptionalToken(`http://${hostname()}:${port}/`, token);
}

function findTailscaleIp(): string | undefined {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 700 }).trim();
    const first = out.split(/\s+/).find(Boolean);
    if (first) return first;
  } catch {
    // Tailscale CLI may not be installed or on PATH.
  }

  const nets = networkInterfaces();
  for (const values of Object.values(nets)) {
    for (const item of values ?? []) {
      if (item.family !== "IPv4" || item.internal) continue;
      if (item.address.startsWith("100.")) return item.address;
    }
  }
  return undefined;
}

function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function renderAppHtml(token: string): string {
  const tokenJson = JSON.stringify(token);
  const pollMsJson = JSON.stringify(POLL_MS);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Pi Canvas" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>pi canvas</title>
  <script>(function(){try{var t=localStorage.getItem('piCanvasTheme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}})();</script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="https://esm.sh/tldraw@3/tldraw.css" />
  <style>
    :root {
      color-scheme: dark;
      --bg: rgb(15, 17, 21);
      --bg-secondary: rgb(26, 29, 35);
      --border: rgba(107, 114, 128, 0.2);
      --text: rgb(201, 204, 209);
      --text-bright: rgb(229, 231, 235);
      --text-muted: rgb(107, 114, 128);
      --text-dimmed: rgb(75, 85, 99);
      --accent: rgb(245, 158, 11);
      --green: rgb(16, 185, 129);
      --red: rgb(239, 68, 68);
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    [data-theme="light"] {
      color-scheme: light;
      --bg: #ffffff;
      --bg-secondary: #f9fafb;
      --border: #e5e7eb;
      --text: #374151;
      --text-bright: #111827;
      --text-muted: #6b7280;
      --text-dimmed: #9ca3af;
      --accent: #d97706;
      --green: #059669;
    }
    *, *::before, *::after { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font-family: var(--font-mono); font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; transition: background 0.2s, color 0.2s; }
    body { padding: max(8px, env(safe-area-inset-top)) 12px max(8px, env(safe-area-inset-bottom)); display:flex; flex-direction:column; }
    body.editing { padding: max(4px, env(safe-area-inset-top)) 6px max(4px, env(safe-area-inset-bottom)); }
    body.editing #appTop, body.editing #appFooter { display:none; }
    button, input, textarea { font: inherit; font-family: var(--font-mono); }
    .app { max-width: 720px; width:100%; margin:0 auto; flex:1; display:flex; flex-direction:column; gap:14px; min-height:0; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:8px; padding: 4px 2px; }
    h1 { margin:0; font-size:14px; font-weight:500; color:var(--text-bright); letter-spacing: 0.02em; }
    .pill { display:inline-flex; align-items:center; gap:6px; color:var(--text-muted); font-size:12px; }
    .dot { width:6px; height:6px; background:var(--green); border-radius:999px; }
    .themeToggle { background:none; border:0; color:var(--text-dimmed); font-size:13px; cursor:pointer; padding:0 6px; transition: color 0.2s; font-family: var(--font-mono); }
    .themeToggle:hover { color:var(--text-muted); }
    .card { border:1px solid var(--border); background:transparent; border-radius:6px; padding:14px 16px; }
    .empty { min-height:30vh; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; color:var(--text-muted); gap:6px; }
    .empty strong { color:var(--text-bright); font-size:14px; font-weight:500; }
    .empty code { color:var(--accent); background:var(--bg-secondary); padding:2px 6px; border-radius:3px; font-size:12px; }
    .requests { display:flex; flex-direction:column; gap:0; }
    .requests .card { border-radius:0; border-left:0; border-right:0; border-top:0; padding:16px 4px; }
    .requests .card:first-child { border-top:1px solid var(--border); }
    .request { display:flex; gap:16px; align-items:flex-start; justify-content:space-between; }
    .reqMain { min-width:0; flex:1; }
    .reqMain strong { font-size:13px; font-weight:500; color:var(--text-bright); display:block; }
    .meta { color:var(--text-muted); font-size:12px; line-height:1.5; margin-top:4px; }
    .prompt { margin-top:8px; color:var(--text-muted); font-size:12px; line-height:1.5; }
    .btn { appearance:none; border:1px solid var(--border); border-radius:5px; padding:7px 12px; color:var(--text-bright); background:transparent; font-weight:500; cursor:pointer; min-height:30px; font-size:12px; font-family: var(--font-mono); transition: color 0.15s, background 0.15s, border-color 0.15s; }
    .btn:hover { color:var(--accent); border-color:var(--accent); }
    .btn.secondary { background:transparent; }
    .btn.danger { color:var(--red); border-color:var(--red); }
    .btn.danger:hover { background:var(--red); color:var(--bg); }
    .btn.ok { background:var(--accent); border-color:var(--accent); color:var(--bg); font-weight:600; }
    .btn.ok:hover { background:transparent; color:var(--accent); }
    .btn.small { min-height:26px; padding:4px 10px; font-size:11px; border-radius:4px; }
    .btn:disabled { opacity:.4; cursor:not-allowed; }
    .editor { display:flex; flex-direction:column; gap:6px; flex:1; min-height:0; }
    .bar { display:flex; align-items:center; gap:6px; padding:4px 6px; background:transparent; border:1px solid var(--border); border-radius:5px; min-height:34px; }
    .iconBtn { appearance:none; border:0; background:transparent; color:var(--text); width:28px; height:28px; border-radius:4px; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; padding:0; transition: color 0.15s, background 0.15s; }
    .iconBtn:hover, .iconBtn[aria-pressed="true"] { color:var(--accent); background:var(--bg-secondary); }
    .iconBtn svg { width:14px; height:14px; stroke:currentColor; stroke-width:1.75; fill:none; stroke-linecap:round; stroke-linejoin:round; }
    .seg { display:inline-flex; background:transparent; border:1px solid var(--border); border-radius:4px; padding:0; gap:0; overflow:hidden; }
    .segBtn { appearance:none; border:0; background:transparent; color:var(--text-muted); padding:4px 9px; border-radius:0; font-size:11px; font-weight:500; cursor:pointer; min-height:22px; font-family: var(--font-mono); border-right:1px solid var(--border); transition: color 0.15s, background 0.15s; }
    .segBtn:last-child { border-right:0; }
    .segBtn:hover { color:var(--text-bright); }
    .segBtn.active { background:var(--bg-secondary); color:var(--accent); }
    .barPrompt { flex:1; min-width:0; color:var(--text-muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:0 4px; }
    .surface { position:relative; flex:1; min-height:50vh; border-radius:5px; overflow:hidden; border:1px solid var(--border); background:var(--bg-secondary); }
    .tldraw-root { position:absolute; inset:0; }
    .status { position:absolute; left:50%; bottom:10px; transform:translateX(-50%); background:var(--bg-secondary); border:1px solid var(--border); color:var(--text-bright); padding:4px 10px; border-radius:4px; font-size:11px; pointer-events:none; opacity:0; transition:opacity .2s; z-index:20; max-width:80%; text-align:center; font-family: var(--font-mono); }
    .status.show { opacity:1; }
    .photoWrap { display:flex; flex-direction:column; gap:8px; padding:10px; background:transparent; border:1px solid var(--border); border-radius:5px; flex:1; min-height:0; }
    .bigPick { display:flex; align-items:center; justify-content:center; padding:14px; background:transparent; border:1px dashed var(--border); border-radius:4px; color:var(--text-muted); font-size:12px; cursor:pointer; transition: color 0.15s, border-color 0.15s; }
    .bigPick:hover { color:var(--accent); border-color:var(--accent); }
    .photoPreview { background:var(--bg-secondary); border-radius:4px; flex:1; min-height:30vh; display:flex; align-items:center; justify-content:center; overflow:hidden; }
    .photoPreview img { max-width:100%; max-height:100%; display:block; }
    .notePanel { padding:0; }
    .notePanel textarea { width:100%; resize:none; height:36px; border-radius:4px; padding:7px 10px; color:var(--text); background:transparent; border:1px solid var(--border); font-size:12px; font-family: var(--font-mono); }
    .notePanel textarea:focus { outline:none; border-color:var(--accent); }
    .footer { color:var(--text-dimmed); font-size:11px; text-align:center; padding-top:8px; }
    .footer code { color:var(--accent); }
    .hidden { display:none !important; }
    @media (max-width: 640px) {
      .request { flex-direction:column; align-items:stretch; gap:8px; }
      .request .btn { width:100%; }
      body { padding-left: 10px; padding-right: 10px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="top" id="appTop">
      <h1>pi canvas</h1>
      <div style="display:flex; align-items:center; gap:10px;">
        <div class="pill"><span class="dot"></span><span id="conn">connected</span></div>
        <button class="themeToggle" id="themeToggle" aria-label="toggle theme">☾</button>
      </div>
    </div>

    <section id="list" class="requests"></section>

    <section id="editorView" class="editor hidden">
      <div class="bar">
        <button class="iconBtn" id="backBtn" aria-label="Back" title="Back">
          <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="seg hidden" id="modeChooser" role="tablist">
          <button class="segBtn" data-mode="draw">draw</button>
          <button class="segBtn" data-mode="photo">photo</button>
          <button class="segBtn" data-mode="annotate">annot</button>
        </div>
        <label class="iconBtn hidden" id="photoBtn" for="photoInput" aria-label="Pick photo" title="Pick photo">
          <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="1.5"/><polyline points="21 17 16 12 5 19"/></svg>
        </label>
        <div class="barPrompt" id="editorMeta"></div>
        <button class="iconBtn" id="noteBtn" aria-label="Add note" aria-pressed="false" title="Note">
          <svg viewBox="0 0 24 24"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn ok small" id="submitBtn">send</button>
      </div>

      <div id="surface" class="surface hidden">
        <div id="tldrawRoot" class="tldraw-root"></div>
        <div id="status" class="status"></div>
      </div>

      <div id="photoWrap" class="photoWrap hidden">
        <label for="photoInput" class="bigPick">tap to pick a photo</label>
        <div class="photoPreview" id="photoPreview"></div>
      </div>

      <div id="notePanel" class="notePanel hidden">
        <textarea id="note" placeholder="optional note for pi..."></textarea>
      </div>

      <input id="photoInput" type="file" accept="image/*" hidden />
    </section>

    <div class="footer" id="appFooter">add to home screen on iphone/ipad. run <code>/canvas</code> in pi.</div>
  </div>

<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "tldraw": "https://esm.sh/tldraw@3?external=react,react-dom"
  }
}
</script>
<script type="module">
  import { createElement } from 'react';
  import { createRoot } from 'react-dom/client';
  import { Tldraw, AssetRecordType, getHashForString } from 'tldraw';

  const api = window.__pi = window.__pi || {};
  let tldrawEditor = null;
  let reactRoot = null;

  function mount() {
    if (reactRoot) return;
    reactRoot = createRoot(document.getElementById('tldrawRoot'));
    reactRoot.render(createElement(Tldraw, {
      onMount: (ed) => {
        tldrawEditor = ed;
        api.editor = ed;
        try { ed.setCurrentTool('draw'); } catch {}
        try {
          const isLight = document.documentElement.getAttribute('data-theme') === 'light';
          ed.user.updateUserPreferences({ colorScheme: isLight ? 'light' : 'dark' });
        } catch {}
      },
    }));
  }

  function setTldrawTheme(scheme) {
    try { tldrawEditor && tldrawEditor.user.updateUserPreferences({ colorScheme: scheme }); } catch {}
  }
  api.setTldrawTheme = setTldrawTheme;

  function clear() {
    if (!tldrawEditor) return;
    const ids = Array.from(tldrawEditor.getCurrentPageShapeIds());
    if (ids.length) tldrawEditor.deleteShapes(ids);
  }

  async function loadImage(file) {
    if (!tldrawEditor) throw new Error('Editor not ready.');
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const assetId = AssetRecordType.createId(getHashForString(url + ':' + Date.now()));
    tldrawEditor.createAssets([{
      id: assetId,
      type: 'image',
      typeName: 'asset',
      meta: {},
      props: {
        name: file.name || 'photo',
        src: url,
        w: img.width,
        h: img.height,
        mimeType: file.type || 'image/jpeg',
        isAnimated: false,
      },
    }]);
    tldrawEditor.createShape({
      type: 'image',
      x: 0,
      y: 0,
      props: { assetId, w: img.width, h: img.height },
    });
    tldrawEditor.selectAll();
    tldrawEditor.zoomToFit({ animation: { duration: 200 } });
    tldrawEditor.selectNone();
  }

  async function exportPng() {
    if (!tldrawEditor) throw new Error('Editor not ready.');
    const ids = Array.from(tldrawEditor.getCurrentPageShapeIds());
    if (!ids.length) throw new Error('Draw something first.');
    const result = await tldrawEditor.toImage(ids, { format: 'png', background: true, scale: 2, padding: 16 });
    if (!result || !result.blob) throw new Error('Export failed.');
    return result.blob;
  }

  api.mountTldraw = mount;
  api.clearTldraw = clear;
  api.loadImageIntoTldraw = loadImage;
  api.exportTldrawPng = exportPng;
  api.ready = true;
  window.dispatchEvent(new Event('pi-tldraw-ready'));
</script>
<script>
const SERVER_TOKEN = ${tokenJson};
const POLL_MS = ${pollMsJson};
const state = { token: SERVER_TOKEN, requests: [], active: null, mode: 'draw', photoBlob: null };
try {
  const urlToken = new URL(location.href).searchParams.get('token');
  if (urlToken) localStorage.setItem('piCanvasToken', urlToken);
  if (!SERVER_TOKEN) localStorage.removeItem('piCanvasToken');
} catch {}
state.token = SERVER_TOKEN || localStorage.getItem('piCanvasToken') || '';

const listEl = document.getElementById('list');
const editorView = document.getElementById('editorView');
const editorMeta = document.getElementById('editorMeta');
const conn = document.getElementById('conn');
const statusEl = document.getElementById('status');
const modeChooser = document.getElementById('modeChooser');
const surfaceEl = document.getElementById('surface');
const photoWrap = document.getElementById('photoWrap');
const photoInput = document.getElementById('photoInput');
const photoPreview = document.getElementById('photoPreview');
const photoBtn = document.getElementById('photoBtn');
const noteBtn = document.getElementById('noteBtn');
const notePanel = document.getElementById('notePanel');

let statusTimer = null;
function withToken(p) { return state.token ? p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(state.token) : p; }
function setStatus(t, opts) {
  statusEl.textContent = t || '';
  statusEl.classList.toggle('show', !!t);
  if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  const ttl = opts && opts.ttl !== undefined ? opts.ttl : (t ? 2400 : 0);
  if (ttl > 0) statusTimer = setTimeout(() => { statusEl.classList.remove('show'); }, ttl);
}
function rel(ts) { const s = Math.max(0, Math.round((Date.now()-ts)/1000)); return s < 60 ? s + 's ago' : Math.round(s/60) + 'm ago'; }

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') node.className = attrs[k];
    else if (k === 'text') node.textContent = attrs[k];
    else if (k === 'style') node.setAttribute('style', attrs[k]);
    else if (k.indexOf('data-') === 0) node.setAttribute(k, attrs[k]);
    else node.setAttribute(k, attrs[k]);
  }
  if (children) for (const c of children) if (c) node.appendChild(c);
  return node;
}
function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

async function refresh() {
  try {
    const res = await fetch(withToken('/api/requests'), { cache:'no-store' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.requests = data.requests || [];
    conn.textContent = state.requests.length ? state.requests.length + ' pending' : 'connected';
    if (!state.active) renderList();
  } catch (e) {
    conn.textContent = 'offline';
  }
}

function renderList() {
  editorView.classList.add('hidden');
  listEl.classList.remove('hidden');
  clearChildren(listEl);
  if (!state.requests.length) {
    const card = el('div', { class: 'card empty' });
    card.appendChild(el('strong', { text: 'no pending requests' }));
    const hint = el('div');
    hint.appendChild(document.createTextNode('run '));
    hint.appendChild(el('code', { text: '/canvas' }));
    hint.appendChild(document.createTextNode(' in pi, then open this page.'));
    card.appendChild(hint);
    listEl.appendChild(card);
    return;
  }
  for (const r of state.requests) {
    const card = el('div', { class: 'card request' });
    const main = el('div', { class: 'reqMain' });
    main.appendChild(el('strong', { text: (r.project || 'pi') + ' \u00b7 ' + r.mode }));
    main.appendChild(el('div', { class: 'meta', text: '#' + String(r.id).slice(0,8) + ' \u00b7 ' + rel(r.createdAt) }));
    if (r.prompt) main.appendChild(el('div', { class: 'prompt', text: r.prompt }));
    const btn = el('button', { class: 'btn', 'data-open': r.id, text: 'open' });
    btn.addEventListener('click', () => openRequest(r.id));
    card.appendChild(main);
    card.appendChild(btn);
    listEl.appendChild(card);
  }
}

async function ensureTldrawReady() {
  const start = Date.now();
  while (!window.__pi || !window.__pi.mountTldraw) {
    if (Date.now() - start > 10000) throw new Error('Drawing tools failed to load.');
    await new Promise(r => setTimeout(r, 60));
  }
  window.__pi.mountTldraw();
  while (!window.__pi.editor) {
    if (Date.now() - start > 12000) throw new Error('Editor not ready.');
    await new Promise(r => setTimeout(r, 60));
  }
  window.__pi.clearTldraw();
}

function setMode(mode) {
  const isAuto = mode === 'auto';
  state.mode = isAuto ? 'draw' : mode;
  modeChooser.classList.toggle('hidden', !isAuto);
  modeChooser.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === state.mode));
  const useTldraw = state.mode === 'draw' || state.mode === 'annotate';
  const usePhotoPanel = state.mode === 'photo';
  surfaceEl.classList.toggle('hidden', !useTldraw);
  photoWrap.classList.toggle('hidden', !usePhotoPanel);
  photoBtn.classList.toggle('hidden', state.mode === 'draw');
  state.photoBlob = null;
  clearChildren(photoPreview);
  if (useTldraw) ensureTldrawReady().catch(e => setStatus(e.message || 'tldraw error', { ttl: 4000 }));
  if (state.mode === 'photo') setStatus('pick a photo, then send.');
  else if (state.mode === 'annotate') setStatus('pick a photo to drop in, then sketch on it.');
  else setStatus('');
}

function openRequest(id) {
  const req = state.requests.find(r => r.id === id);
  if (!req) return;
  state.active = req;
  listEl.classList.add('hidden');
  editorView.classList.remove('hidden');
  document.body.classList.add('editing');
  editorMeta.textContent = req.prompt || '';
  setMode(req.mode);
}

function closeEditor() {
  state.active = null;
  document.body.classList.remove('editing');
  notePanel.classList.add('hidden');
  noteBtn.setAttribute('aria-pressed', 'false');
  setStatus('');
  renderList();
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files && photoInput.files[0];
  if (!file) return;
  state.photoBlob = file;
  const url = URL.createObjectURL(file);
  clearChildren(photoPreview);
  const img = el('img', { alt: 'preview' });
  img.src = url;
  photoPreview.appendChild(img);
  if (state.mode === 'annotate') {
    try {
      await ensureTldrawReady();
      await window.__pi.loadImageIntoTldraw(file);
      setStatus('photo dropped in. sketch and send.');
    } catch (e) {
      setStatus('could not load photo: ' + (e && e.message ? e.message : e), { ttl: 4000 });
    }
  } else {
    setStatus('photo ready. tap send.');
  }
  photoInput.value = '';
});

document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.getElementById('backBtn').addEventListener('click', closeEditor);
noteBtn.addEventListener('click', () => {
  const open = notePanel.classList.toggle('hidden') === false;
  noteBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  if (open) document.getElementById('note').focus();
});

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const url = String(r.result); res(url.split(',')[1] || ''); };
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

document.getElementById('submitBtn').addEventListener('click', async () => {
  if (!state.active) return;
  setStatus('Submitting...');
  try {
    let blob, mimeType;
    if (state.mode === 'photo') {
      if (!state.photoBlob) throw new Error('Pick a photo first.');
      blob = state.photoBlob;
      mimeType = blob.type || 'image/jpeg';
    } else {
      blob = await window.__pi.exportTldrawPng();
      mimeType = 'image/png';
    }
    const imageBase64 = await blobToBase64(blob);
    const note = document.getElementById('note').value.trim();
    const res = await fetch(withToken('/api/requests/' + encodeURIComponent(state.active.id) + '/submit'), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ imageBase64, mimeType, note, deviceName: navigator.userAgent }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || res.statusText || 'Submit failed');
    setStatus('sent \u2713');
    document.getElementById('note').value = '';
    await refresh();
    closeEditor();
  } catch (e) { setStatus('send failed: ' + (e && e.message ? e.message : e), { ttl: 4000 }); }
});

const themeToggle = document.getElementById('themeToggle');
function applyTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  if (themeToggle) themeToggle.textContent = theme === 'light' ? '☀' : '☾';
  if (window.__pi && window.__pi.setTldrawTheme) window.__pi.setTldrawTheme(theme === 'light' ? 'light' : 'dark');
}
applyTheme(localStorage.getItem('piCanvasTheme') || 'dark');
themeToggle && themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  localStorage.setItem('piCanvasTheme', next);
  applyTheme(next);
});

refresh();
setInterval(refresh, POLL_MS);
</script>
</body>
</html>`;
}

function renderUnauthorizedHtml(): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pi Canvas</title><style>body{font-family:system-ui;background:#0d0f14;color:#f5f7fb;padding:24px;line-height:1.5}code{background:#202431;padding:2px 5px;border-radius:6px}</style></head><body><h1>Pi Canvas</h1><p>Missing or invalid token.</p><p>This broker was started with <code>PI_CANVAS_TOKEN</code>. Run <code>/canvas status</code> in Pi and open the URL it prints.</p></body></html>`;
}

async function startBrokerServer(bindHost: string, port: number, token: string): Promise<Server> {
  const requests = new Map<string, CanvasRequest>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const statusCode = getHttpStatus(error);
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) writeJson(res, statusCode, { ok: false, error: message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/device")) {
      if (!isAuthorized(req, token, url)) {
        writeHtml(res, renderUnauthorizedHtml());
        return;
      }
      writeHtml(res, renderAppHtml(token));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { ok: true, name: "pi-canvas", pending: [...requests.values()].filter(r => r.status === "pending" || r.status === "claimed").length });
      return;
    }

    if (!isAuthorized(req, token, url)) {
      writeJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/requests") {
      cleanupExpiredRequests(requests);
      const pending = [...requests.values()]
        .filter(r => r.status === "pending" || r.status === "claimed")
        .sort((a, b) => a.createdAt - b.createdAt);
      writeJson(res, 200, { ok: true, requests: pending });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/requests") {
      const body = await readJson<CreateRequestBody>(req, 128 * 1024);
      const mode = normalizeMode(body.mode) ?? "auto";
      const now = Date.now();
      const request: CanvasRequest = {
        id: randomUUID(),
        pid: body.pid,
        cwd: body.cwd,
        project: body.project || projectNameForCwd(body.cwd),
        mode,
        prompt: body.prompt?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        status: "pending",
      };
      requests.set(request.id, request);
      cleanupExpiredRequests(requests);
      writeJson(res, 200, { ok: true, request });
      return;
    }

    const submitMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/submit$/);
    if (req.method === "POST" && submitMatch) {
      const id = decodeURIComponent(submitMatch[1]);
      const request = requests.get(id);
      if (!request || (request.status !== "pending" && request.status !== "claimed")) {
        throw httpError(404, "Canvas request not found or already completed.");
      }

      const body = await readJson<SubmitRequestBody>(req, MAX_JSON_BYTES + 1024 * 1024);
      const { imagePath, bytes } = persistSubmittedImage(request, body);
      request.status = "submitted";
      request.updatedAt = Date.now();

      writeInboxMessage(request.pid, {
        type: "canvas_result",
        requestId: request.id,
        imagePath,
        mimeType: body.mimeType || "image/png",
        note: body.note?.trim() || undefined,
        prompt: request.prompt,
        mode: request.mode,
        project: request.project,
        from: body.deviceName,
        timestamp: new Date().toISOString(),
      });

      writeJson(res, 200, { ok: true, imagePath, bytes });
      setTimeout(() => requests.delete(request.id), 30_000).unref?.();
      return;
    }

    writeJson(res, 404, { ok: false, error: "Not found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => resolve());
  });

  return server;
}

async function ensureBroker(): Promise<BrokerStartResult> {
  const token = getConfiguredToken();
  const port = envPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  if (globalBroker.server) return { role: "server", baseUrl, token };

  try {
    const server = await startBrokerServer(envBind(), port, token);
    globalBroker.server = server;
    return { role: "server", baseUrl, token };
  } catch (error) {
    // If another pi-canvas extension owns the shared port, use it as the broker.
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return { role: "client", baseUrl, token };
    } catch {
      // Keep original error below.
    }
    throw error;
  }
}

const globalBroker: { server?: Server } = {};

function buildCanvasMessage(msg: InboxMessage): string {
  const lines = [
    "Canvas input received. Please inspect and use this image in your answer.",
    `Image path: ${msg.imagePath}`,
    `Mode: ${msg.mode}`,
  ];
  if (msg.prompt) lines.push(`Original prompt: ${msg.prompt}`);
  if (msg.note) lines.push(`User note: ${msg.note}`);
  return lines.join("\n");
}

type CanvasUserContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function readImageContent(msg: InboxMessage): CanvasUserContent[] {
  const text = buildCanvasMessage(msg);
  try {
    const stat = statSync(msg.imagePath);
    if (stat.size > MAX_IMAGE_INLINE_BYTES) return [{ type: "text", text }];
    const data = readFileSync(msg.imagePath).toString("base64");
    return [
      { type: "text", text },
      { type: "image", data, mimeType: msg.mimeType || "image/png" },
    ];
  } catch {
    return [{ type: "text", text }];
  }
}

export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;
  let inboxWatcher: FSWatcher | undefined;
  let inboxTimer: ReturnType<typeof setTimeout> | undefined;
  const myPid = process.pid;
  const myInboxDir = join(inboxBaseDir, String(myPid));

  function deliverCanvasResult(msg: InboxMessage) {
    const content = readImageContent(msg);
    try {
      if (lastCtx?.isIdle?.()) {
        pi.sendUserMessage(content);
      } else {
        pi.sendUserMessage(content, { deliverAs: "followUp" });
      }
    } catch {
      pi.sendMessage({ customType: "pi-canvas", content: buildCanvasMessage(msg), display: true }, { triggerTurn: true, deliverAs: "followUp" });
    }
  }

  function processInbox() {
    ensureDir(myInboxDir);
    let files: string[] = [];
    try {
      files = readdirSync(myInboxDir).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = join(myInboxDir, file);
      try {
        const msg = JSON.parse(readFileSync(filePath, "utf8")) as InboxMessage;
        if (msg.type === "canvas_result" && msg.imagePath) deliverCanvasResult(msg);
      } catch {
        // Ignore bad inbox files.
      } finally {
        try { unlinkSync(filePath); } catch {}
      }
    }
  }

  function startInboxWatcher() {
    ensureDir(myInboxDir);
    processInbox();
    if (inboxWatcher) return;
    try {
      inboxWatcher = watch(myInboxDir, () => {
        if (inboxTimer) clearTimeout(inboxTimer);
        inboxTimer = setTimeout(() => {
          inboxTimer = undefined;
          processInbox();
        }, 75);
      });
    } catch {
      // fs.watch can fail on some filesystems; /canvas submission still writes files.
    }
  }

  async function createCanvasRequest(mode: CanvasMode, prompt: string | undefined, ctx: ExtensionContext) {
    const broker = await ensureBroker();
    const port = envPort();
    const deviceUrl = getTailnetOrLocalUrl(port, broker.token);
    const payload: CreateRequestBody = {
      pid: myPid,
      cwd: ctx.cwd || process.cwd(),
      project: projectNameForCwd(ctx.cwd || process.cwd()),
      mode,
      prompt,
    };
    const result = await postJson<{ ok: true; request: CanvasRequest }>(`${broker.baseUrl}/api/requests`, broker.token, payload);
    ctx.ui.setStatus("canvas", "canvas: pending");
    ctx.ui.notify([
      `Canvas request ready (${result.request.mode}).`,
      "Open Pi Canvas on any Tailscale device:",
      deviceUrl,
    ].join("\n"), "info");
    return { request: result.request, deviceUrl, broker };
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    startInboxWatcher();
    try {
      const broker = await ensureBroker();
      const url = getTailnetOrLocalUrl(envPort(), broker.token);
      ctx.ui.setStatus("canvas", broker.role === "server" ? "canvas: ready" : "canvas: shared");
      // Keep startup quiet; /canvas status shows URL.
      void url;
    } catch {
      ctx.ui.setStatus("canvas", "canvas: off");
    }
  });

  pi.on("session_shutdown", async () => {
    if (inboxTimer) clearTimeout(inboxTimer);
    inboxWatcher?.close();
    inboxWatcher = undefined;
    try { rmSync(myInboxDir, { recursive: true, force: true }); } catch {}
    if (globalBroker.server) {
      const server = globalBroker.server;
      globalBroker.server = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  pi.registerCommand("canvas", {
    description: "Request drawing/photo input from any Tailscale-connected phone, iPad, or browser",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      startInboxWatcher();
      const parsed = parseCanvasArgs(args);

      try {
        const broker = await ensureBroker();
        const url = getTailnetOrLocalUrl(envPort(), broker.token);

        if (parsed.special === "status") {
          ctx.ui.notify([
            `Pi Canvas broker: ${broker.role}`,
            `Home Screen URL: ${url}`,
            `Inbox: ${myInboxDir}`,
            "Usage: /canvas [draw|photo|annotate] [optional prompt]",
          ].join("\n"), "info");
          return;
        }

        if (parsed.special === "open") {
          await openBrowser(url);
          ctx.ui.notify("Pi Canvas opened locally. Use the same URL from your phone/iPad Home Screen.", "info");
          return;
        }

        await createCanvasRequest(parsed.mode, parsed.prompt, ctx);
      } catch (error) {
        ctx.ui.setStatus("canvas", "canvas: error");
        ctx.ui.notify(`Pi Canvas error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
