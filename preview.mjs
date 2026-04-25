import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const out = ts.transpileModule(src, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const dir = mkdtempSync(join(tmpdir(), "pi-canvas-preview-"));
const file = join(dir, "index.mjs");
writeFileSync(file, out.outputText);
const mod = await import(file);

const html = mod.renderAppHtml("");
const fakeRequest = {
  id: "preview-0001-aaaa-bbbb-cccc-1234567890ab",
  pid: 4242,
  cwd: process.cwd(),
  project: "pi-canvas",
  mode: "auto",
  prompt: "sketch the dataflow for pi canvas.",
  createdAt: Date.now() - 12 * 1000,
  updatedAt: Date.now(),
  status: "pending",
};

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/api/requests")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, requests: [fakeRequest] }));
    return;
  }
  if (req.method === "POST" && req.url?.includes("/submit")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, imagePath: "/tmp/x.png", bytes: 1 }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
server.listen(18121, "127.0.0.1", () => {
  console.log("preview at http://127.0.0.1:18121/");
});
