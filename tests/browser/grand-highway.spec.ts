import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

type GrandHighwayEvidence = {
  deckFound: boolean;
  rearCavityHits: number;
  outsideRightRimHits: number;
  noteCount: number;
  centerNoteLength: number | null;
  trebleNoteLength: number | null;
  centerFrontZ: number | null;
  trebleFrontZ: number | null;
  leftCheek: { found: boolean; vertexCount: number; finiteUnitNormals: boolean };
  rightCheek: { found: boolean; vertexCount: number; finiteUnitNormals: boolean };
};

type Preset = "concert" | "overhead" | "pov" | "side_arch";

declare global {
  interface Window {
    __grandHighway?: {
      evidence: GrandHighwayEvidence;
      renderPreset: (preset: Preset) => void;
      renderCheekDetail: (side: "left" | "right") => void;
      renderBrandingDetail: () => { found: boolean; lines: string[]; position: number[]; goldPixels: number };
      renderCheekCloseup: () => {
        leftCheek: GrandHighwayEvidence["leftCheek"];
        rightCheek: GrandHighwayEvidence["rightCheek"];
      };
      dispose: () => void;
    };
    __grandHighwayError?: string;
  }
}

const presets: Preset[] = ["concert", "overhead", "pov", "side_arch"];
const harnessFile = resolve(process.cwd(), "tests/browser/r3d/grand-highway.html").replaceAll("\\", "/");

test("3D grand highway fills the curved tail, clips beyond the rim, and renders all fixed cameras", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/@fs/${harnessFile}`);
  await page.waitForFunction(() => Boolean(window.__grandHighway || window.__grandHighwayError));

  const bootError = await page.evaluate(() => window.__grandHighwayError ?? null);
  expect(bootError, "the real Three.js scene must initialize in Chromium").toBeNull();
  const harness = page.locator("#preset-scene-host");
  await expect(harness).toBeVisible();
  const evidence = await page.evaluate(() => window.__grandHighway!.evidence);
  await info.attach("geometry-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });

  await page.locator("#full-grand-canvas").screenshot({ path: info.outputPath("grand-highway-full-grand.png") });
  for (const preset of presets) {
    await page.evaluate((cameraPreset) => window.__grandHighway!.renderPreset(cameraPreset), preset);
    await harness.screenshot({ path: info.outputPath(`grand-highway-${preset}.png`) });
  }
  const cheekEvidence = await page.evaluate(() => window.__grandHighway!.renderCheekCloseup());
  await page.locator("#full-grand-canvas").screenshot({ path: info.outputPath("grand-highway-cheeks-closeup.png") });
  for (const side of ["left", "right"] as const) {
    await page.evaluate((value) => window.__grandHighway!.renderCheekDetail(value), side);
    await page.locator("#full-grand-canvas").screenshot({ path: info.outputPath(`grand-highway-cheek-${side}.png`) });
  }
  const branding = await page.evaluate(() => window.__grandHighway!.renderBrandingDetail());
  await page.locator("#full-grand-canvas").screenshot({ path: info.outputPath("grand-piano-branding.png") });
  await info.attach("branding-evidence", { body: JSON.stringify(branding, null, 2), contentType: "application/json" });
  expect(branding.found).toBe(true);
  expect(branding.lines).toEqual(["PIANOMOTION", "CONCERT GRAND"]);
  expect(branding.position[0]).toBeCloseTo(0, 5);
  expect(branding.position[1]).toBeGreaterThan(-5.75);
  expect(branding.position[1]).toBeLessThan(-0.72);
  expect(branding.position[2]).toBeGreaterThan(0.95);
  expect(branding.goldPixels, "gold lettering must be visible on the black front apron").toBeGreaterThan(100);

  expect(evidence.deckFound, "the highway mesh should be part of the rendered falling-note scene").toBe(true);
  expect(evidence.rearCavityHits, "the highway should reach the curved tail beyond the former z=-33.2 deck end").toBeGreaterThan(0);
  expect(evidence.outsideRightRimHits, "the highway surface should stop inside the right bentside").toBe(0);
  expect(evidence.noteCount).toBe(2);
  expect(evidence.centerNoteLength).not.toBeNull();
  expect(evidence.trebleNoteLength).not.toBeNull();
  expect(evidence.centerNoteLength!).toBeGreaterThan(evidence.trebleNoteLength! + 1);
  expect(evidence.centerFrontZ).toBeCloseTo(-5.2, 2);
  expect(evidence.trebleFrontZ).toBeCloseTo(-5.2, 2);
  for (const [side, cheek] of Object.entries(cheekEvidence)) {
    expect(cheek.found, `the named ${side} cheek should be in the production keyboard geometry`).toBe(true);
    expect(cheek.vertexCount, `${side} cheek should use the detailed curved case geometry`).toBeGreaterThan(6000);
    expect(cheek.finiteUnitNormals, `${side} cheek should have finite normalized vertex normals`).toBe(true);
  }

  await page.evaluate(() => window.__grandHighway!.dispose());
});
