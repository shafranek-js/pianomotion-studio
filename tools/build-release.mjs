import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateOfflineManifest } from "./generate-offline-manifest.mjs";
import { prepareBuiltinSoundfont } from "./prepare-builtin-soundfont.mjs";
import { prepareBuiltinMelodies } from "./prepare-builtin-melodies.mjs";
import { assertReleaseAssets } from "./release-assets.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const clientRoot = path.join(webRoot, "apps", "client");
const publicRoot = path.join(clientRoot, "public");
const viteConfig = path.join(clientRoot, "vite.config.ts");
const viteCli = path.join(webRoot, "node_modules", "vite", "bin", "vite.js");
const releaseMarker = 'const BUILD_ID = "__PIANOMOTION_BUILD_ID__";';

function normalizeAppBase(value) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes("?") || value.includes("#")) {
    throw new Error("APP_BASE must be a path such as / or /pianomotion/.");
  }
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  const normalized = withLeadingSlash.replace(/\/{2,}/g, "/");
  if (normalized.includes("\\") || normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("APP_BASE cannot contain backslashes or dot segments.");
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  const ignoredDirectories = new Set([
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    ".vite",
    ".git",
    "dist",
    "coverage",
    "htmlcov",
    "test-results",
    "playwright-report",
  ]);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      files.push(...(await filesBelow(fullPath)));
    } else if (entry.isFile() && !/\.(?:pyc|pyo)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function buildInputFiles() {
  const files = new Set();
  const directoryInputs = [
    path.join(clientRoot, "src"),
    publicRoot,
    path.join(webRoot, "python-core"),
    path.join(webRoot, "packages", "contracts", "src"),
    path.join(webRoot, "packages", "engine-ts", "src"),
    path.join(webRoot, "builtin_melodies", "midi"),
  ];
  for (const directory of directoryInputs) {
    for (const file of await filesBelow(directory)) {
      if (path.resolve(file) === path.join(publicRoot, "offline-manifest.json")) {
        continue;
      }
      files.add(path.resolve(file));
    }
  }

  const explicitInputs = [
    "package.json",
    "package-lock.json",
    "apps/client/package.json",
    "packages/engine-ts/package.json",
    "packages/engine-ts/tsconfig.json",
    "apps/client/index.html",
    "apps/client/vite.config.ts",
    "apps/client/tsconfig.json",
    "apps/client/tsconfig.app.json",
    "apps/client/tsconfig.node.json",
    "tsconfig.tools.json",
    "tools/build-release.mjs",
    "tools/generate-offline-manifest.mjs",
    "tools/prepare-pyodide-runtime.mjs",
    "tools/prepare-builtin-melodies.mjs",
    "tools/prepare-builtin-soundfont.mjs",
    "tools/package-python-core.mjs",
    "tools/pyodide-runtime-manifest.json",
  ];
  for (const relative of explicitInputs) {
    const fullPath = path.join(webRoot, relative);
    try {
      await stat(fullPath);
      files.add(fullPath);
    } catch {
      // Some packaging helpers are optional in local focused builds.
    }
  }
  return [...files].sort((a, b) => path.relative(webRoot, a).localeCompare(path.relative(webRoot, b)));
}

async function computeBuildId(appBase) {
  const hash = createHash("sha256");
  hash.update(`APP_BASE=${appBase}\n`);
  hash.update("BUILD_MODE=production\n");
  hash.update(`RELEASE_BUILD_TAG=${process.env.RELEASE_BUILD_TAG ?? ""}\n`);
  for (const file of await buildInputFiles()) {
    const relative = path.relative(webRoot, file).replace(/\\/g, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

function getOption(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertSafeOutputDirectory(requestedOutDir, resolvedOutDir) {
  const defaultDistRoot = path.resolve(clientRoot, "dist");
  if (requestedOutDir && !path.isAbsolute(requestedOutDir)) {
    throw new Error("A custom --outDir must be an absolute path.");
  }
  if (resolvedOutDir === defaultDistRoot) {
    try {
      const info = await lstat(resolvedOutDir);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("apps/client/dist must be a real directory, not a symbolic link or file.");
      }
      const expectedPath = path.join(await realpath(clientRoot), "dist");
      if (await realpath(resolvedOutDir) !== expectedPath) {
        throw new Error("The apps/client/dist output resolves outside its expected directory.");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return;
  }

  const tempRoot = await realpath(path.resolve(tmpdir()));
  // GitHub's Windows runners expose the temp directory through an 8.3 short
  // name (RUNNER~1); path.resolve keeps it, realpath expands it. Canonicalise
  // the parent so the containment and job-directory checks compare like paths.
  const canonicalParent = await realpath(path.dirname(resolvedOutDir));
  const canonicalOutDir = path.join(canonicalParent, path.basename(resolvedOutDir));
  const relativeToTemp = path.relative(tempRoot, canonicalOutDir);
  const tempJobDirectory = path.basename(canonicalParent);
  const outputName = path.basename(canonicalOutDir);
  const isExplicitPwaTestOutput = process.env.PIANOMOTION_TEST_BUILD === "1" &&
    isWithin(tempRoot, canonicalOutDir) &&
    /^pianomotion-pwa-releases-[a-z0-9-]+$/i.test(tempJobDirectory) &&
    /^release-[a-z0-9-]+$/i.test(outputName);
  if (!isExplicitPwaTestOutput || relativeToTemp === "" || relativeToTemp.startsWith(`..${path.sep}`) || relativeToTemp === "..") {
    throw new Error("A custom --outDir is allowed only for apps/client/dist or an explicitly marked temporary PWA test output.");
  }
  if (canonicalParent !== path.resolve(tempRoot, tempJobDirectory)) {
    throw new Error("The temporary PWA output directory resolves outside its test job directory.");
  }
  try {
    if ((await lstat(canonicalOutDir)).isSymbolicLink()) {
      throw new Error("A temporary PWA output directory cannot be a symbolic link.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function runViteBuild(distRoot, appBase, assetBase, buildId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      viteCli,
      "build",
      "--config",
      viteConfig,
      "--outDir",
      distRoot,
      "--emptyOutDir",
    ], {
      cwd: webRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        // A programmatic Vite dev server can set NODE_ENV in its host process.
        // A release must never inherit that setting and disable its own SW.
        NODE_ENV: "production",
        VITE_BASE: assetBase,
        VITE_APP_BASE_PATH: appBase,
        VITE_RELEASE_BUILD_ID: buildId,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Vite build failed (${signal ?? `exit ${code}`}).`));
      }
    });
  });
}

async function copyReleaseAssets(releaseRoot) {
  await mkdir(releaseRoot, { recursive: true });
  const entries = await readdir(publicRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "sw.js" || entry.name === "offline-manifest.json" || entry.name === "_headers") {
      continue;
    }
    await cp(path.join(publicRoot, entry.name), path.join(releaseRoot, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

async function moveViteAssetsToRelease(distRoot, releaseRoot) {
  const builtAssets = path.join(distRoot, "assets");
  const releaseAssets = path.join(releaseRoot, "assets");
  await stat(builtAssets);
  await mkdir(releaseRoot, { recursive: true });
  await rename(builtAssets, releaseAssets);
}

/** Files that must stay at the site root: the shell, the worker and hosting rules. */
const DIST_ROOT_FILES = new Set(["sw.js", "_headers"]);

const CSP_LINE = /^[ \t]*Content-Security-Policy:[ \t]*(.+)$/im;
/** Directives a <meta> CSP cannot deliver; they stay in `_headers` for hosts that honour it. */
const META_UNSUPPORTED_CSP = /^(frame-ancestors|report-uri|report-to|sandbox)\b/i;

/**
 * GitHub Pages ignores `_headers`, so the policy is also delivered as a meta tag
 * in the built `index.html`. The policy is read from `_headers` so the two cannot
 * drift apart, and directives that are invalid in a meta tag are dropped.
 */
async function injectCspMeta(distRoot) {
  const headers = await readFile(path.join(publicRoot, "_headers"), "utf8");
  const match = CSP_LINE.exec(headers);
  if (!match) {
    throw new Error("_headers is missing its Content-Security-Policy line.");
  }
  const policy = match[1]
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0 && !META_UNSUPPORTED_CSP.test(directive))
    .join("; ");
  const indexPath = path.join(distRoot, "index.html");
  const html = await readFile(indexPath, "utf8");
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    return false;
  }
  const content = policy.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
  await writeFile(indexPath, html.replace(/<head>/i, `<head>\n    ${meta}`));
  return true;
}


/**
 * Vite copies `public/` to the dist root, and the release build copies the same
 * tree into `releases/<buildId>/`. The app only ever loads the release copy, so
 * the root duplicates are dead weight: 67 MiB on a 138 MiB deployment. Remove
 * them, leaving the shell, the service worker and the hosting rules.
 *
 * Only names that exist in `public/` are touched, so a custom `--outDir` keeps
 * anything else it may contain.
 */
async function pruneDuplicatePublicAssets(distRoot) {
  const entries = await readdir(publicRoot, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (DIST_ROOT_FILES.has(entry.name)) {
      continue;
    }
    const target = path.join(distRoot, entry.name);
    try {
      await lstat(target);
    } catch {
      continue; // Vite did not copy this entry (missing or empty input).
    }
    await rm(target, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

async function patchReleaseManifest(releaseRoot, appBase, assetBase) {
  const manifestPath = path.join(releaseRoot, "manifest.webmanifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scope = appBase;
  manifest.start_url = appBase;
  manifest.icons = (manifest.icons ?? []).map((icon) => ({
    ...icon,
    src: new URL(String(icon.src).replace(/^\/+/, ""), `https://release.invalid${assetBase}`).pathname,
  }));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function embedBuildIdInWorker(distRoot, buildId) {
  const swPath = path.join(distRoot, "sw.js");
  const source = await readFile(swPath, "utf8");
  if (!source.includes(releaseMarker)) {
    throw new Error("public/sw.js is missing its release ID marker.");
  }
  await writeFile(swPath, source.replace(releaseMarker, `const BUILD_ID = "${buildId}";`));
}

async function main() {
  await prepareBuiltinMelodies();
  await prepareBuiltinSoundfont();
  await assertReleaseAssets(publicRoot);
  const appBase = normalizeAppBase(process.env.APP_BASE ?? process.env.VITE_APP_BASE_PATH ?? process.env.VITE_BASE ?? "/");
  const buildId = await computeBuildId(appBase);
  const assetBase = `${appBase}releases/${buildId}/`;
  const requestedOutDir = getOption("--outDir");
  const distRoot = path.resolve(requestedOutDir ?? path.join(clientRoot, "dist"));
  await assertSafeOutputDirectory(requestedOutDir, distRoot);

  console.log(`Building PianoMotion release ${buildId} (app base ${appBase}, asset base ${assetBase}).`);
  await runViteBuild(distRoot, appBase, assetBase, buildId);

  const releaseRoot = path.join(distRoot, "releases", buildId);
  await moveViteAssetsToRelease(distRoot, releaseRoot);
  await copyReleaseAssets(releaseRoot);
  await patchReleaseManifest(releaseRoot, appBase, assetBase);
  const pruned = await pruneDuplicatePublicAssets(distRoot);
  if (pruned.length > 0) {
    console.log(`Removed ${pruned.length} duplicate public entries from the dist root: ${pruned.join(", ")}`);
  }
  if (await injectCspMeta(distRoot)) {
    console.log("Injected the Content-Security-Policy meta tag into index.html.");
  }
  await embedBuildIdInWorker(distRoot, buildId);
  await generateOfflineManifest({ distRoot, buildId });
}

main().catch((error) => {
  console.error("Release build failed:", error);
  process.exitCode = 1;
});
