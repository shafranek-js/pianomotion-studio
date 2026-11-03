/**
 * publicMidiSearch.ts - Browser-side search & download for Public Domain / Creative Commons
 * MIDI files from Wikimedia Commons and Internet Archive.
 *
 * Adapted from Mizan (MIT License, host/mizan/midi_search.py).
 */

export type PublicMidiLicense = "Public Domain" | "CC0" | "CC BY" | "CC BY-SA";
export type PublicMidiProvider = "commons" | "archive";

export interface PublicMidiSearchResult {
  readonly id: string;
  readonly dedupeKey: string;
  readonly provider: PublicMidiProvider;
  readonly source: "Wikimedia Commons" | "Internet Archive";
  readonly title: string;
  readonly artist: string | null;
  readonly license: PublicMidiLicense;
  readonly licenseUrl: string | null;
  readonly attribution: string;
  readonly url: string;
  readonly sourceUrl: string;
  readonly size?: number;
}

export const MAX_MIDI_BYTES = 2 * 1024 * 1024;
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const ARCHIVE_SEARCH_API = "https://archive.org/advancedsearch.php";
const ARCHIVE_CC0_URL = "http://creativecommons.org/publicdomain/zero/1.0/";

const COMMONS_HOSTS = new Set(["commons.wikimedia.org", "upload.wikimedia.org"]);
const ARCHIVE_HOSTS = new Set(["archive.org", "*.archive.org"]);

export function validateSearchQuery(query: string): string {
  if (typeof query !== "string") {
    throw new Error("Search query must be a string.");
  }
  const trimmed = query.trim();
  if (trimmed.length > 200) {
    throw new Error("Search query must be 200 characters or fewer.");
  }
  return trimmed;
}

export function cleanHtmlText(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const withoutScripts = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const decoded = withoutScripts
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
  return decoded.replace(/\s+/g, " ").trim();
}

export function normalizeLicenseName(value: string): PublicMidiLicense | null {
  const name = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (/^(?:public domain)(?:\b|$)/.test(name)) {
    return "Public Domain";
  }
  if (/^(?:cc0|creative commons zero)(?:\b|$)/.test(name)) {
    return "CC0";
  }
  if (/^(?:cc by-sa|creative commons attribution[- ]sharealike)(?![\w-])/.test(name)) {
    return "CC BY-SA";
  }
  if (/^(?:cc by|creative commons attribution)(?![\w-])/.test(name)) {
    return "CC BY";
  }
  return null;
}

export function isApprovedHttpsUrl(url: string, allowedHosts: ReadonlySet<string>): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 4096) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return false;
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  for (const allowed of allowedHosts) {
    if (host === allowed) return true;
    if (allowed.startsWith("*.") && host.endsWith(allowed.slice(1))) return true;
  }
  return false;
}

function normalizeUrlDedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `https://${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function parseCommonsResponse(payload: unknown): PublicMidiSearchResult[] {
  if (!payload || typeof payload !== "object") return [];
  const query = (payload as Record<string, unknown>).query;
  if (!query || typeof query !== "object") return [];
  const rawPages = (query as Record<string, unknown>).pages;
  const pages: Array<Record<string, unknown>> = Array.isArray(rawPages)
    ? rawPages.filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
    : rawPages && typeof rawPages === "object"
      ? Object.values(rawPages as Record<string, unknown>).filter(
          (p): p is Record<string, unknown> => Boolean(p && typeof p === "object"),
        )
      : [];

  pages.sort((a, b) => {
    const ia = typeof a.index === "number" ? a.index : 0x7fffffff;
    const ib = typeof b.index === "number" ? b.index : 0x7fffffff;
    return ia - ib;
  });

  const results: PublicMidiSearchResult[] = [];
  for (const page of pages) {
    const imageinfo = page.imageinfo;
    if (!Array.isArray(imageinfo) || imageinfo.length === 0) continue;
    const image = imageinfo[0] as Record<string, unknown> | undefined;
    if (!image || typeof image !== "object") continue;
    const metadata = image.extmetadata as Record<string, unknown> | undefined;
    if (!metadata || typeof metadata !== "object") continue;

    const metaText = (key: string): string => {
      const entry = metadata[key];
      if (!entry || typeof entry !== "object") return "";
      return cleanHtmlText((entry as Record<string, unknown>).value);
    };

    const licenseShort = metaText("LicenseShortName");
    const usageTerms = metaText("UsageTerms");
    const licenseName = normalizeLicenseName(licenseShort || usageTerms);
    const fileUrl = typeof image.url === "string" ? image.url : "";
    const sourceUrl = typeof image.descriptionurl === "string" ? image.descriptionurl : "";
    const mime = typeof image.mime === "string" ? image.mime.toLowerCase() : "";
    const rawTitle = cleanHtmlText(page.title);
    const title = rawTitle.replace(/^File:/i, "").trim();

    if (
      !licenseName ||
      !fileUrl ||
      !sourceUrl ||
      !["audio/midi", "audio/x-midi", "application/x-midi"].includes(mime)
    ) {
      continue;
    }

    let pathLower = "";
    try {
      pathLower = new URL(fileUrl).pathname.toLowerCase();
    } catch {
      continue;
    }
    if (!pathLower.endsWith(".mid") && !pathLower.endsWith(".midi")) {
      continue;
    }
    if (
      !isApprovedHttpsUrl(fileUrl, COMMONS_HOSTS) ||
      !isApprovedHttpsUrl(sourceUrl, new Set(["commons.wikimedia.org"]))
    ) {
      continue;
    }

    const artist = metaText("Artist").slice(0, 300) || null;
    const credit = metaText("Credit").slice(0, 1000) || artist || null;
    const attributionRequired = ["true", "yes", "1"].includes(
      metaText("AttributionRequired").toLowerCase(),
    );
    if ((licenseName === "CC BY" || licenseName === "CC BY-SA" || attributionRequired) && !credit) {
      continue;
    }

    const rawLicenseUrl = metaText("LicenseUrl");
    const licenseUrl =
      rawLicenseUrl &&
      isApprovedHttpsUrl(
        rawLicenseUrl,
        new Set(["creativecommons.org", "commons.wikimedia.org"]),
      )
        ? rawLicenseUrl
        : null;

    const pageId = page.pageid ?? normalizeUrlDedupeKey(fileUrl);
    const size = typeof image.size === "number" && image.size > 0 ? image.size : undefined;
    if (size !== undefined && size > MAX_MIDI_BYTES) continue;

    results.push({
      id: `commons:${String(pageId)}`,
      dedupeKey: normalizeUrlDedupeKey(fileUrl),
      provider: "commons",
      source: "Wikimedia Commons",
      title: title.slice(0, 300) || "Untitled MIDI",
      artist,
      license: licenseName,
      licenseUrl,
      attribution: credit || `Attribution not required (${licenseName})`,
      url: fileUrl,
      sourceUrl,
      ...(size !== undefined ? { size } : {}),
    });

    if (results.length >= 8) break;
  }

  return results;
}

export function parseArchiveItem(
  identifier: string,
  payload: unknown,
  searchLicense: string | null = null,
): PublicMidiSearchResult[] {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(identifier)) return [];
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const item = obj.metadata as Record<string, unknown> | undefined;
  const files = obj.files as unknown[] | undefined;
  if (!item || typeof item !== "object" || item.identifier !== identifier || !Array.isArray(files)) {
    return [];
  }
  const licenseUrl = typeof item.licenseurl === "string" ? item.licenseurl : "";
  if (
    licenseUrl !== ARCHIVE_CC0_URL ||
    (searchLicense !== null && searchLicense !== ARCHIVE_CC0_URL)
  ) {
    return [];
  }

  const title = cleanHtmlText(item.title).slice(0, 300) || identifier;
  const rawCreator = item.creator;
  const artist = Array.isArray(rawCreator)
    ? rawCreator
        .filter((v): v is string => typeof v === "string")
        .map((v) => cleanHtmlText(v))
        .filter(Boolean)
        .join("; ")
        .slice(0, 300) || null
    : cleanHtmlText(rawCreator).slice(0, 300) || null;

  const midiFiles: Array<{ name: string; size: number; fileUrl: string }> = [];
  for (const rawFile of files) {
    if (!rawFile || typeof rawFile !== "object") continue;
    const file = rawFile as Record<string, unknown>;
    if (file.source !== "original") continue;
    const name = typeof file.name === "string" ? file.name : "";
    if (!name || name.includes("..")) continue;
    const format = typeof file.format === "string" ? file.format.toLowerCase() : "";
    const lowerName = name.toLowerCase();
    if (format !== "midi" && !lowerName.endsWith(".mid") && !lowerName.endsWith(".midi")) {
      continue;
    }
    const size = Number(file.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_MIDI_BYTES) continue;
    const fileUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(name)}`;
    if (!isApprovedHttpsUrl(fileUrl, ARCHIVE_HOSTS)) continue;
    midiFiles.push({ name, size, fileUrl });
  }

  return midiFiles.map(({ name, size, fileUrl }) => {
    const leaf = name.slice(name.lastIndexOf("/") + 1).replace(/\.(?:mid|midi)$/i, "");
    const displayTitle = midiFiles.length === 1 ? title : `${title} — ${leaf}`.slice(0, 300);
    return {
      id: `archive:${identifier}:${name}`,
      dedupeKey: normalizeUrlDedupeKey(fileUrl),
      provider: "archive",
      source: "Internet Archive",
      title: displayTitle,
      artist,
      license: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      attribution: artist ? `Creator: ${artist}` : "Attribution not required (CC0)",
      url: fileUrl,
      sourceUrl: `https://archive.org/details/${identifier}`,
      size,
    };
  });
}

export async function searchWikimediaCommonsMidi(
  query: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicMidiSearchResult[]> {
  const text = validateSearchQuery(query);
  if (!text) return [];
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${text} filemime:audio/midi`,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiextmetadatafilter:
      "LicenseShortName|LicenseUrl|Artist|Credit|UsageTerms|AttributionRequired",
    format: "json",
    formatversion: "2",
    origin: "*",
  });
  const response = await fetchImpl(`${COMMONS_API}?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Wikimedia Commons search failed (${response.status}).`);
  }
  const payload: unknown = await response.json();
  return parseCommonsResponse(payload);
}

function buildArchiveSearchQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const escaped = terms.map(
    (term) => `"${term.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1")}"`,
  );
  const base = `format:"MIDI" AND licenseurl:"${ARCHIVE_CC0_URL}"`;
  return escaped.length > 0 ? `${base} AND ${escaped.join(" AND ")}` : base;
}

export async function searchInternetArchiveMidi(
  query: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicMidiSearchResult[]> {
  const text = validateSearchQuery(query);
  if (!text) return [];
  const params = new URLSearchParams();
  params.set("q", buildArchiveSearchQuery(text));
  params.append("fl[]", "identifier");
  params.append("fl[]", "title");
  params.append("fl[]", "licenseurl");
  params.set("rows", "5");
  params.set("page", "1");
  params.set("output", "json");

  const response = await fetchImpl(`${ARCHIVE_SEARCH_API}?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Internet Archive search failed (${response.status}).`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const docs = (payload.response as Record<string, unknown> | undefined)?.docs;
  if (!Array.isArray(docs)) return [];

  const results: PublicMidiSearchResult[] = [];
  for (const rawDoc of docs.slice(0, 5)) {
    if (!rawDoc || typeof rawDoc !== "object") continue;
    const doc = rawDoc as Record<string, unknown>;
    const identifier = typeof doc.identifier === "string" ? doc.identifier : "";
    const licenseUrl = typeof doc.licenseurl === "string" ? doc.licenseurl : "";
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(identifier) || licenseUrl !== ARCHIVE_CC0_URL) {
      continue;
    }
    try {
      const metaRes = await fetchImpl(
        `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        { signal },
      );
      if (!metaRes.ok) continue;
      const metadata: unknown = await metaRes.json();
      results.push(...parseArchiveItem(identifier, metadata, licenseUrl));
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
    }
  }
  return results.slice(0, 10);
}

/**
 * Search both Wikimedia Commons and Internet Archive in parallel and deduplicate results.
 */
export async function searchPublicDomainMidi(
  query: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicMidiSearchResult[]> {
  const text = validateSearchQuery(query);
  if (!text) return [];

  const settled = await Promise.allSettled([
    searchWikimediaCommonsMidi(text, signal, fetchImpl),
    searchInternetArchiveMidi(text, signal, fetchImpl),
  ]);

  const combined: PublicMidiSearchResult[] = [];
  const seen = new Set<string>();
  let anyFulfilled = false;
  let firstError: unknown = null;

  for (const item of settled) {
    if (item.status === "fulfilled") {
      anyFulfilled = true;
      for (const res of item.value) {
        if (!seen.has(res.dedupeKey)) {
          seen.add(res.dedupeKey);
          combined.push(res);
        }
      }
    } else {
      if (item.reason instanceof Error && item.reason.name === "AbortError") {
        throw item.reason;
      }
      firstError = firstError ?? item.reason;
    }
  }

  if (!anyFulfilled && firstError) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  return combined;
}

/**
 * Download and verify a Public Domain / CC MIDI file (`MThd` header + 2 MB size limit).
 */
export async function downloadPublicMidiBytes(
  result: PublicMidiSearchResult,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer> {
  const allowedHosts = result.provider === "commons" ? COMMONS_HOSTS : ARCHIVE_HOSTS;
  if (!isApprovedHttpsUrl(result.url, allowedHosts)) {
    throw new Error("The MIDI URL is not on an approved HTTPS host.");
  }
  const response = await fetchImpl(result.url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to download MIDI (${response.status}).`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_MIDI_BYTES) {
    throw new Error("The MIDI file is larger than 2 MB.");
  }
  const bytes = new Uint8Array(buffer);
  if (
    bytes.byteLength < 14 ||
    bytes[0] !== 0x4d ||
    bytes[1] !== 0x54 ||
    bytes[2] !== 0x68 ||
    bytes[3] !== 0x64
  ) {
    throw new Error("Downloaded file is not a valid Standard MIDI File (missing MThd header).");
  }
  return buffer;
}
