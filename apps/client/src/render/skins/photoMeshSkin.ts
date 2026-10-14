import { Container, type Graphics } from "pixi.js";
import type { HandGeometry } from "./geometry";
import { renderRealisticSkin } from "./realisticSkin";
import type { SkinSettings } from "./types";

export class PhotoMeshRenderer {
  public readonly container: Container;

  constructor() {
    this.container = new Container();
  }

  public render(
    graphics: Graphics,
    geom: HandGeometry,
    skinSettings: SkinSettings,
    ppi: number,
  ): void {
    renderRealisticSkin(graphics, geom, skinSettings, ppi);
  }

  public destroy(): void {
    this.container.destroy({ children: true });
  }
}
