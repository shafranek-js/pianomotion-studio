import { Container, Sprite, Texture, type Graphics } from "pixi.js";
import type { HandGeometry, ScreenPoint } from "./geometry";
import { renderRealisticSkin } from "./realisticSkin";
import { depthScale, type SkinSettings } from "./types";

interface SpriteMeta {
  anchorRight: [number, number];
  restLength: number;
}

const FINGER_META: Record<number, SpriteMeta> = {
  1: { anchorRight: [0.732, 0.808], restLength: 180.3 },
  2: { anchorRight: [0.567, 0.971], restLength: 309.0 },
  3: { anchorRight: [0.497, 0.973], restLength: 341.0 },
  4: { anchorRight: [0.367, 0.956], restLength: 301.6 },
  5: { anchorRight: [0.103, 0.926], restLength: 233.5 },
};

const DORSUM_META: SpriteMeta = {
  anchorRight: [0.536, 0.932],
  restLength: 390.0,
};

const FOREARM_META: SpriteMeta = {
  anchorRight: [0.5, 0.075],
  restLength: 370.0,
};

export class PhotoRigRenderer {
  public readonly container: Container;
  private forearmSprite: Sprite;
  private dorsumSprite: Sprite;
  private fingerSprites: Record<number, Sprite>;
  private isLoaded = false;
  private currentHand: "left" | "right" = "right";

  constructor() {
    this.container = new Container();

    this.forearmSprite = new Sprite(Texture.EMPTY);
    this.dorsumSprite = new Sprite(Texture.EMPTY);
    this.fingerSprites = {
      1: new Sprite(Texture.EMPTY),
      2: new Sprite(Texture.EMPTY),
      3: new Sprite(Texture.EMPTY),
      4: new Sprite(Texture.EMPTY),
      5: new Sprite(Texture.EMPTY),
    };

    this.container.addChild(this.forearmSprite);
    this.container.addChild(this.fingerSprites[1]!);
    this.container.addChild(this.dorsumSprite);
    for (let f = 2; f <= 5; f++) {
      this.container.addChild(this.fingerSprites[f]!);
    }

    this.loadTextures("right");
  }

  private loadTextures(hand: "left" | "right"): void {
    try {
      const suffix = hand === "left" ? "_left" : "";
      this.currentHand = hand;

      this.forearmSprite.texture = Texture.from(`/textures/photo-rig/forearm${suffix}.png`);
      this.dorsumSprite.texture = Texture.from(`/textures/photo-rig/dorsum${suffix}.png`);

      for (let f = 1; f <= 5; f++) {
        this.fingerSprites[f]!.texture = Texture.from(`/textures/photo-rig/finger_${f}${suffix}.png`);
      }
      this.isLoaded = true;
    } catch {
      this.isLoaded = false;
    }
  }

  public render(
    graphics: Graphics,
    geom: HandGeometry,
    skinSettings: SkinSettings,
    ppi: number,
  ): void {
    // 1. Draw base anatomical render underneath
    renderRealisticSkin(graphics, geom, skinSettings, ppi);

    if (geom.hand !== this.currentHand) {
      this.loadTextures(geom.hand);
    }

    const isLeft = geom.hand === "left";
    const widthScale = skinSettings.finger_width * depthScale(geom.palmZIn);

    // 2. Forearm Sprite
    const armLen = Math.hypot(
      geom.armEnd.x - geom.wristCenter.x,
      geom.armEnd.y - geom.wristCenter.y,
    );
    const armAngle = Math.atan2(geom.armUnit.y, geom.armUnit.x) - Math.PI / 2;

    const armAnchorX = isLeft ? 1.0 - FOREARM_META.anchorRight[0] : FOREARM_META.anchorRight[0];
    this.forearmSprite.anchor.set(armAnchorX, FOREARM_META.anchorRight[1]);
    this.forearmSprite.position.set(geom.wristCenter.x, geom.wristCenter.y);
    this.forearmSprite.rotation = armAngle;
    this.forearmSprite.scale.set(
      (geom.wristWidth / 120.0) * (isLeft ? -1 : 1),
      armLen / FOREARM_META.restLength,
    );
    this.forearmSprite.visible = !skinSettings.sleeve;

    // 3. Dorsum (Palm) Sprite
    const midMcp = geom.chains[3]?.[1] ?? geom.wristCenter;
    const palmDx = midMcp.x - geom.wristCenter.x;
    const palmDy = midMcp.y - geom.wristCenter.y;
    const palmLen = Math.hypot(palmDx, palmDy);
    const palmAngle = Math.atan2(palmDy, palmDx) + Math.PI / 2;

    const dorsumAnchorX = isLeft ? 1.0 - DORSUM_META.anchorRight[0] : DORSUM_META.anchorRight[0];
    this.dorsumSprite.anchor.set(dorsumAnchorX, DORSUM_META.anchorRight[1]);
    this.dorsumSprite.position.set(geom.wristCenter.x, geom.wristCenter.y);
    this.dorsumSprite.rotation = palmAngle;
    this.dorsumSprite.scale.set(
      (geom.wristWidth / 110.0) * widthScale * (isLeft ? -1 : 1),
      (palmLen / DORSUM_META.restLength) * 2.3,
    );
    this.dorsumSprite.alpha = 0.96;

    // 4. Fingers 1..5 Sprites
    for (let f = 1; f <= 5; f++) {
      const sprite = this.fingerSprites[f]!;
      const chain = geom.chains[f];
      const meta = FINGER_META[f];
      if (!chain || chain.length < 2 || !meta) {
        sprite.visible = false;
        continue;
      }

      const mcp = chain[1]!;
      const tip = chain[chain.length - 1]!;
      const fDx = tip.x - mcp.x;
      const fDy = tip.y - mcp.y;
      const fLen = Math.hypot(fDx, fDy);
      const fAngle = Math.atan2(fDy, fDx) + Math.PI / 2;

      const anchorX = isLeft ? 1.0 - meta.anchorRight[0] : meta.anchorRight[0];
      sprite.anchor.set(anchorX, meta.anchorRight[1]);
      sprite.position.set(mcp.x, mcp.y);
      sprite.rotation = fAngle;

      const segRadius = geom.radius[f]?.[0]?.radius ?? 10;
      const fWidthScale = (segRadius / 14.0) * widthScale * (isLeft ? -1 : 1);
      const fLenScale = fLen / meta.restLength;

      sprite.scale.set(fWidthScale, fLenScale);
      sprite.alpha = 0.98;
      sprite.visible = true;
    }
  }

  public destroy(): void {
    this.container.destroy({ children: true });
  }
}
