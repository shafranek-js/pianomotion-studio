import { unzipSync } from "fflate";

export const MAX_UNCOMPRESSED_ARCHIVE_BYTES = 32 * 1024 * 1024; // 32 MiB

export interface XmlNode {
  readonly tagName: string;
  readonly localName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  readonly text: string;
  getAttribute(name: string): string | null;
  child(localName: string): XmlNode | undefined;
  childrenNamed(localName: string): XmlNode[];
  findFirst(localName: string): XmlNode | undefined;
  findAll(localName: string): XmlNode[];
  textOf(localName: string): string | null;
}

class XmlElementNode implements XmlNode {
  readonly tagName: string;
  readonly localName: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlElementNode[] = [];
  textParts: string[] = [];
  private cachedText: string | null = null;

  constructor(tagName: string, attributes: Record<string, string>) {
    this.tagName = tagName;
    const colonIdx = tagName.indexOf(":");
    this.localName = colonIdx >= 0 ? tagName.slice(colonIdx + 1) : tagName;
    this.attributes = attributes;
  }

  get text(): string {
    if (this.cachedText !== null) return this.cachedText;
    if (this.children.length === 0) {
      this.cachedText = this.textParts.join("");
      return this.cachedText;
    }
    const parts = [...this.textParts];
    for (const child of this.children) {
      parts.push(child.text);
    }
    this.cachedText = parts.join("");
    return this.cachedText;
  }

  getAttribute(name: string): string | null {
    if (Object.prototype.hasOwnProperty.call(this.attributes, name)) {
      return this.attributes[name]!;
    }
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(this.attributes)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  }

  child(localName: string): XmlNode | undefined {
    for (const c of this.children) {
      if (c.localName === localName || c.tagName === localName) return c;
    }
    return undefined;
  }

  childrenNamed(localName: string): XmlNode[] {
    const out: XmlNode[] = [];
    for (const c of this.children) {
      if (c.localName === localName || c.tagName === localName) {
        out.push(c);
      }
    }
    return out;
  }

  findFirst(localName: string): XmlNode | undefined {
    for (const c of this.children) {
      if (c.localName === localName || c.tagName === localName) return c;
      const nested = c.findFirst(localName);
      if (nested) return nested;
    }
    return undefined;
  }

  findAll(localName: string): XmlNode[] {
    const out: XmlNode[] = [];
    const visit = (node: XmlElementNode) => {
      for (const c of node.children) {
        if (c.localName === localName || c.tagName === localName) {
          out.push(c);
        }
        visit(c);
      }
    };
    visit(this);
    return out;
  }

  textOf(localName: string): string | null {
    const found = this.child(localName);
    return found ? found.text.trim() : null;
  }
}

export function decodeXmlEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (match, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default: {
          if (entity.startsWith("#x") || entity.startsWith("#X")) {
            const code = Number.parseInt(entity.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
          }
          if (entity.startsWith("#")) {
            const code = Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
          }
          return match;
        }
      }
    },
  );
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex =
    /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrText)) !== null) {
    const name = match[1]!;
    const val = match[2] ?? match[3] ?? "";
    attrs[name] = decodeXmlEntities(val);
  }
  return attrs;
}

/**
 * Parses an XML document string into a lightweight, queryable XmlNode root element.
 * Works identically in browser main thread, Web Workers, and Node.js unit tests.
 */
export function parseXmlDocument(xmlText: string): XmlNode {
  const rootWrapper = new XmlElementNode("#document", {});
  const stack: XmlElementNode[] = [rootWrapper];

  let i = 0;
  const len = xmlText.length;

  // Strip UTF-8 BOM if present
  if (len > 0 && xmlText.charCodeAt(0) === 0xfeff) {
    i = 1;
  }

  while (i < len) {
    const lt = xmlText.indexOf("<", i);
    if (lt === -1) {
      const trailing = xmlText.slice(i);
      if (trailing.trim().length > 0) {
        stack[stack.length - 1]!.textParts.push(decodeXmlEntities(trailing));
      }
      break;
    }

    if (lt > i) {
      const textChunk = xmlText.slice(i, lt);
      if (textChunk.length > 0) {
        stack[stack.length - 1]!.textParts.push(decodeXmlEntities(textChunk));
      }
    }

    // Comment <!-- ... -->
    if (xmlText.startsWith("<!--", lt)) {
      const endComment = xmlText.indexOf("-->", lt + 4);
      i = endComment === -1 ? len : endComment + 3;
      continue;
    }

    // CDATA <![CDATA[ ... ]]>
    if (xmlText.startsWith("<![CDATA[", lt)) {
      const endCdata = xmlText.indexOf("]]>", lt + 9);
      const content =
        endCdata === -1
          ? xmlText.slice(lt + 9)
          : xmlText.slice(lt + 9, endCdata);
      stack[stack.length - 1]!.textParts.push(content);
      i = endCdata === -1 ? len : endCdata + 3;
      continue;
    }

    // Processing instruction <? ... ?>
    if (xmlText.startsWith("<?", lt)) {
      const endPi = xmlText.indexOf("?>", lt + 2);
      i = endPi === -1 ? len : endPi + 2;
      continue;
    }

    // DOCTYPE or other declaration <! ... >
    if (xmlText.startsWith("<!", lt)) {
      let depth = 1;
      let pos = lt + 2;
      let inQuote: string | null = null;
      while (pos < len && depth > 0) {
        const ch = xmlText[pos]!;
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
        } else if (ch === '"' || ch === "'") {
          inQuote = ch;
        } else if (ch === "<") {
          depth++;
        } else if (ch === ">") {
          depth--;
        }
        pos++;
      }
      i = pos;
      continue;
    }

    // Find closing '>' taking quotes into account
    let gt = lt + 1;
    let inQuote: string | null = null;
    while (gt < len) {
      const ch = xmlText[gt]!;
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === ">") {
        break;
      }
      gt++;
    }

    if (gt >= len) {
      throw new Error("Malformed XML document: unclosed tag.");
    }

    const rawTag = xmlText.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (rawTag.length === 0) continue;

    // Closing tag </tag>
    if (rawTag.startsWith("/")) {
      const closeName = rawTag.slice(1).trim();
      const closeLocal = closeName.includes(":")
        ? closeName.slice(closeName.indexOf(":") + 1)
        : closeName;
      if (stack.length > 1) {
        const top = stack[stack.length - 1]!;
        if (top.tagName === closeName || top.localName === closeLocal) {
          stack.pop();
        } else {
          // Recover gracefully if mismatched tag
          for (let s = stack.length - 1; s >= 1; s--) {
            if (
              stack[s]!.tagName === closeName ||
              stack[s]!.localName === closeLocal
            ) {
              stack.length = s;
              break;
            }
          }
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const tagBody = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const spaceMatch = /\s/.exec(tagBody);
    const tagName = spaceMatch
      ? tagBody.slice(0, spaceMatch.index)
      : tagBody;
    const attrStr = spaceMatch ? tagBody.slice(spaceMatch.index) : "";
    const attrs = attrStr.length > 0 ? parseAttributes(attrStr) : {};

    const element = new XmlElementNode(tagName, attrs);
    stack[stack.length - 1]!.children.push(element);
    if (!selfClosing) {
      stack.push(element);
    }
  }

  const root = rootWrapper.children[0];
  if (!root) {
    throw new Error("Invalid XML document: no root element found.");
  }
  return root;
}

/**
 * Decodes an XML byte buffer (supporting UTF-8, UTF-16 LE, and UTF-16 BE).
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.byteLength >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Unpacks a ZIP archive (.mxl, .mlx, .mscz) in memory while enforcing uncompressed size limits.
 */
export function unzipArchiveEntries(
  zipBytes: Uint8Array,
  maxBytes: number = MAX_UNCOMPRESSED_ARCHIVE_BYTES,
): Record<string, Uint8Array> {
  let totalUncompressed = 0;
  const entries = unzipSync(zipBytes, {
    filter(file) {
      totalUncompressed += file.originalSize ?? 0;
      if (totalUncompressed > maxBytes) {
        throw new Error(
          `Compressed score archive exceeds maximum uncompressed size limit (${Math.round(maxBytes / (1024 * 1024))} MiB).`,
        );
      }
      return true;
    },
  });

  // Double-check actual decompressed byte lengths
  let actualTotal = 0;
  for (const data of Object.values(entries)) {
    actualTotal += data.byteLength;
    if (actualTotal > maxBytes) {
      throw new Error(
        `Compressed score archive exceeds maximum uncompressed size limit (${Math.round(maxBytes / (1024 * 1024))} MiB).`,
      );
    }
  }
  return entries;
}
