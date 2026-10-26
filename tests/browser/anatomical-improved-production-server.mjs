import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const requestedRoot = process.env.PIANOMOTION_RELEASE_ROOT ?? path.join(repositoryRoot, "apps", "client", "dist");
const releaseRoot = await realpath(requestedRoot);
const indexPath = path.join(releaseRoot, "index.html");
await stat(indexPath);

const appBase = "/pianomotion-studio/";
const port = Number(process.env.PIANOMOTION_PRODUCTION_SMOKE_PORT ?? 4218);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".glb", "model/gltf-binary"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mid", "audio/midi"],
  [".midi", "audio/midi"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  if (!pathname.startsWith(appBase)) {
    response.writeHead(404).end("Not found");
    return;
  }

  const relativePath = pathname.slice(appBase.length) || "index.html";
  let filePath = path.resolve(releaseRoot, relativePath);
  const pathFromRoot = path.relative(releaseRoot, filePath);
  if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      info = await stat(filePath);
    }
    const headers = {
      "Cache-Control": relativePath === "sw.js" ? "no-store" : "no-cache",
      "Content-Length": String(info.size),
      "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    };
    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404, { "Cache-Control": "no-store" });
    response.end("Not found");
  }
});

server.on("error", error => {
  console.error(`Production UI smoke server failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Serving ${releaseRoot} at http://127.0.0.1:${port}${appBase}`);
});
