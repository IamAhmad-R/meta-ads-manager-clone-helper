// Tiny static server so extension modules load over http for UI testing
// (file:// blocks ES module imports).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = "D:/opencode/meta-ads-clone/extension";
const PORT = Number(process.argv[2] || 8787);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const requested = decodeURIComponent(url.pathname) === "/" ? "/ui/popup.html" : decodeURIComponent(url.pathname);
  const file = normalize(join(ROOT, requested));
  if (!file.startsWith(normalize(ROOT))) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
