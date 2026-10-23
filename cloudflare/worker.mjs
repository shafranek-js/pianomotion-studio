/**
 * Serve checksum-preserving, Cloudflare-size-compatible SoundFont parts at the
 * original URL. The app, service worker, and offline manifest remain unchanged.
 * All regular static files are served directly by Cloudflare, without a Worker hit.
 */
const SF3_URL = /^\/releases\/[a-f0-9]{24}\/soundfonts\/musescore-general\/([a-f0-9]{64})\.sf3$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = SF3_URL.exec(url.pathname);
    if (!match || (request.method !== "GET" && request.method !== "HEAD")) {
      return env.ASSETS.fetch(request);
    }

    const metadataUrl = new URL(url.pathname + ".parts.json", url.origin);
    const metadataResponse = await env.ASSETS.fetch(new Request(metadataUrl));
    if (!metadataResponse.ok) return new Response("SoundFont release parts unavailable", { status: 404 });

    let info;
    try {
      info = await metadataResponse.json();
      if (info.schemaVersion !== 1 || info.sha256 !== match[1] ||
          !Number.isSafeInteger(info.sizeBytes) || info.sizeBytes <= 0 ||
          !Array.isArray(info.parts) || info.parts.length === 0 ||
          info.parts.some((part, i) => part.name !== match[1] + ".sf3.part-" + i ||
            !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes <= 0 || part.sizeBytes > 25 * 1024 * 1024) ||
          info.parts.reduce((sum, part) => sum + part.sizeBytes, 0) !== info.sizeBytes) {
        throw new Error("Invalid parts manifest");
      }
    } catch {
      return new Response("Invalid SoundFont release manifest", { status: 502 });
    }

    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(info.sizeBytes),
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": '"' + info.sha256 + '"',
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method === "HEAD") return new Response(null, { headers });

    let reader = null;
    let index = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            if (!reader) {
              if (index >= info.parts.length) {
                controller.close();
                return;
              }
              const partUrl = new URL(info.parts[index].name, metadataUrl);
              const response = await env.ASSETS.fetch(new Request(partUrl));
              if (!response.ok || !response.body) throw new Error("Missing SoundFont part " + index);
              reader = response.body.getReader();
            }
            const { done, value } = await reader.read();
            if (done) {
              reader.releaseLock();
              reader = null;
              index++;
              continue;
            }
            controller.enqueue(value);
            return;
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader?.cancel(reason);
      },
    });
    return new Response(stream, { headers });
  },
};
