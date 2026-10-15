declare const __APP_BASE_PATH__: string;
declare const __PIANOMOTION_BUILD_ID__: string;

function getOrigin(): string {
  return typeof globalThis.location === "undefined" ? "http://localhost" : globalThis.location.origin;
}

function normalizeBasePath(value: string): string {
  const path = value.startsWith("/") ? value : `/${value}`;
  return path.endsWith("/") ? path : `${path}/`;
}

function relativePath(value: string): string {
  return value.replace(/^\/+/, "");
}

/** Resolves app-shell URLs against the stable registration scope. */
export function appBaseUrl(path = ""): URL {
  const configured = typeof __APP_BASE_PATH__ === "string"
    ? __APP_BASE_PATH__
    : import.meta.env.BASE_URL || "/";
  const base = new URL(normalizeBasePath(configured), getOrigin());
  return new URL(relativePath(path), base);
}

/** Resolves immutable files that belong to this exact application build. */
export function releaseAssetUrl(path: string): URL {
  const base = new URL(import.meta.env.BASE_URL || "/", getOrigin());
  if (!base.pathname.endsWith("/")) {
    base.pathname += "/";
  }
  return new URL(relativePath(path), base);
}

export function applicationBuildId(): string {
  return typeof __PIANOMOTION_BUILD_ID__ === "string" ? __PIANOMOTION_BUILD_ID__ : "development";
}
