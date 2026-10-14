import { Container, MeshSimple, Texture, type Graphics } from "pixi.js";
import type { HandGeometry } from "./geometry";
import {
  PHOTO_MESH_URLS,
  getLoadedTexture,
  isPhotoMeshReady,
  preloadAllPhotoAssets,
} from "./photoAssets";
import { renderRealisticSkin } from "./realisticSkin";
import { depthScale, type SkinSettings } from "./types";

const GRID_COLS = 12;
const GRID_ROWS = 16;
const NUM_VERTICES = (GRID_COLS + 1) * (GRID_ROWS + 1);

export class PhotoMeshRenderer {
  public readonly container: Container;
  private mesh: MeshSimple | null = null;
  private restUvs: Float32Array;
  private vertices: Float32Array;
  private currentHand: "left" | "right" | null = null;

  constructor() {
    this.container = new Container();
    this.container.visible = false;

    this.restUvs = new Float32Array(NUM_VERTICES * 2);
    this.vertices = new Float32Array(NUM_VERTICES * 2);

    // Initialize regular grid UVs
    let idx = 0;
    for (let r = 0; r <= GRID_ROWS; r++) {
      const v = r / GRID_ROWS;
      for (let c = 0; c <= GRID_COLS; c++) {
        const u = c / GRID_COLS;
        this.restUvs[idx * 2] = u;
        this.restUvs[idx * 2 + 1] = v;
        idx++;
      }
    }

    preloadAllPhotoAssets().catch(() => {});
  }

  public render(
    graphics: Graphics,
    geom: HandGeometry,
    skinSettings: SkinSettings,
    ppi: number,
  ): void {
    const hand = geom.hand;

    // Check if texture is fully loaded and ready
    if (!isPhotoMeshReady(hand)) {
      preloadAllPhotoAssets().catch(() => {});
      this.container.visible = false;
      renderRealisticSkin(graphics, geom, skinSettings, ppi);
      return;
    }

    const texUrl = hand === "left" ? PHOTO_MESH_URLS.left : PHOTO_MESH_URLS.right;
    const tex = getLoadedTexture(texUrl);
    if (!tex) {
      this.container.visible = false;
      renderRealisticSkin(graphics, geom, skinSettings, ppi);
      return;
    }

    if (!this.mesh) {
      try {
        this.mesh = new MeshSimple({
          texture: tex,
          vertices: this.vertices,
          uvs: this.restUvs,
        });
        this.container.addChild(this.mesh);
      } catch {
        this.mesh = null;
        this.container.visible = false;
        renderRealisticSkin(graphics, geom, skinSettings, ppi);
        return;
      }
    }

    if (this.currentHand !== hand) {
      this.currentHand = hand;
      this.mesh.texture = tex;
    }

    this.container.visible = true;
    this.mesh.visible = true;

    const isLeft = hand === "left";
    const widthScale = skinSettings.finger_width * depthScale(geom.palmZIn);

    // Key screen anchor landmarks
    const wrist = geom.wristCenter;
    const mcp1 = geom.chains[1]?.[1] ?? wrist;
    const mcp2 = geom.chains[2]?.[1] ?? wrist;
    const mcp3 = geom.chains[3]?.[1] ?? wrist;
    const mcp4 = geom.chains[4]?.[1] ?? wrist;
    const mcp5 = geom.chains[5]?.[1] ?? wrist;

    const tip1 = geom.chains[1]?.[geom.chains[1]?.length - 1] ?? mcp1;
    const tip2 = geom.chains[2]?.[geom.chains[2]?.length - 1] ?? mcp2;
    const tip3 = geom.chains[3]?.[geom.chains[3]?.length - 1] ?? mcp3;
    const tip4 = geom.chains[4]?.[geom.chains[4]?.length - 1] ?? mcp4;
    const tip5 = geom.chains[5]?.[geom.chains[5]?.length - 1] ?? mcp5;

    const mcps = [mcp1, mcp2, mcp3, mcp4, mcp5];
    const tips = [tip1, tip2, tip3, tip4, tip5];

    let vIdx = 0;
    for (let r = 0; r <= GRID_ROWS; r++) {
      const v = r / GRID_ROWS;
      for (let c = 0; c <= GRID_COLS; c++) {
        const u = c / GRID_COLS;
        const normU = isLeft ? 1.0 - u : u;

        let px = wrist.x;
        let py = wrist.y;

        if (v > 0.7) {
          // Forearm zone: extends along geom.armUnit
          const armDist = (v - 0.7) * 2.5 * ppi * 1.2;
          const lat = (normU - 0.5) * geom.wristWidth * widthScale;
          const nu = { x: -geom.armUnit.y, y: geom.armUnit.x };
          px = wrist.x + geom.armUnit.x * armDist + nu.x * lat;
          py = wrist.y + geom.armUnit.y * armDist + nu.y * lat;
        } else if (v > 0.42) {
          // Palm zone: interpolates between wrist and MCP knuckles
          const palmT = (0.7 - v) / (0.7 - 0.42); // 0 at wrist, 1 at knuckles
          const fingerIdx = Math.max(0, Math.min(4, Math.floor(normU * 5)));
          const targetMcp = mcps[fingerIdx]!;
          const basePx = wrist.x + (targetMcp.x - wrist.x) * palmT;
          const basePy = wrist.y + (targetMcp.y - wrist.y) * palmT;
          const lat = (normU - 0.5) * (geom.wristWidth * 0.9) * (1 - palmT * 0.2);
          const nu = { x: -geom.armUnit.y, y: geom.armUnit.x };
          px = basePx + nu.x * lat;
          py = basePy + nu.y * lat;
        } else {
          // Finger zone: attaches to fingers 1..5
          const fingerFloat = Math.max(0, Math.min(4, normU * 5));
          const fingerIdx = Math.min(4, Math.floor(fingerFloat));
          const m = mcps[fingerIdx]!;
          const t = tips[fingerIdx]!;

          // Progress from knuckle (v=0.42) to tip (v=0.0)
          const fingerT = Math.max(0, Math.min(1, (0.42 - v) / 0.42));
          const alongX = m.x + (t.x - m.x) * fingerT;
          const alongY = m.y + (t.y - m.y) * fingerT;

          // Normal vector perpendicular to finger axis
          const fLen = Math.hypot(t.x - m.x, t.y - m.y) || 1;
          const fn = { x: -(t.y - m.y) / fLen, y: (t.x - m.x) / fLen };

          const localU = (normU * 5) - fingerIdx - 0.5;
          const halfW = (geom.radius[fingerIdx + 1]?.[0]?.radius ?? 12) * widthScale * 1.5;

          px = alongX + fn.x * localU * halfW;
          py = alongY + fn.y * localU * halfW;
        }

        this.vertices[vIdx * 2] = px;
        this.vertices[vIdx * 2 + 1] = py;
        vIdx++;
      }
    }

    this.mesh.alpha = 0.95;
    this.mesh.visible = true;
  }

  public destroy(): void {
    this.container.destroy({ children: true });
  }
}
