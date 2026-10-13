import type { MotionPlan, MotionPose } from "@handthesia/contracts";
import { Container, Graphics, Text } from "pixi.js";
import { LOWEST_PIANO_KEY, type KeyboardLayout } from "./keyboardView";
import { lerpPose, type MotionBuffer } from "./motionBuffer";
import {
  buildHandGeometry,
  getFingerTipsByFinger,
  normalizeSkinSettings,
  renderCartoonSkin,
  renderGlovesSkin,
  renderHandShadow,
  renderRobotSkin,
  renderSkeletonSkin,
  type SkinSettings,
} from "./skins";

export interface HandsViewOptions {
  motionPlan?: MotionPlan | null;
  keyboardLayout?: KeyboardLayout;
  skinSettings?: SkinSettings;
  motionBuffer?: MotionBuffer | null;
}


export class SingleHandRenderer {
  public readonly container = new Container();
  public readonly shadowGraphics = new Graphics();
  public readonly handGraphics = new Graphics();
  public readonly labelsContainer = new Container();
  private labelTextPool: Text[] = [];

  public constructor() {
    this.container.addChild(this.shadowGraphics);
    this.container.addChild(this.handGraphics);
    this.container.addChild(this.labelsContainer);
  }

  public clear(): void {
    this.shadowGraphics.clear();
    this.handGraphics.clear();
    for (const text of this.labelTextPool) {
      text.visible = false;
    }
  }

  public render(
    pose: MotionPose,
    keyboardLayout: KeyboardLayout,
    skinSettings: SkinSettings,
    showFingerLabels = true,
  ): void {
    this.clear();

    const key21 = keyboardLayout.getKeyRect(LOWEST_PIANO_KEY);
    const keyboardLeft = key21 ? key21.x : keyboardLayout.rect.x;
    const keyboardBottom = keyboardLayout.rect.y + keyboardLayout.rect.height;
    const ppi = keyboardLayout.ppi > 0 ? keyboardLayout.ppi : 50;

    const toScreen = (pt: [number, number, number]) => ({
      x: keyboardLeft + pt[0] * ppi,
      y: keyboardBottom - pt[1] * ppi,
      zIn: pt[2],
    });

    const isLeft = pose.hand === "left";
    const accentColor = isLeft ? 0x3b82f6 : 0x10b981; // LH blue, RH green

    // 1. Build reconstructed hand geometry
    const geom = buildHandGeometry(pose, keyboardLayout, skinSettings);

    // 2. Render Soft Projected Drop Shadow (beneath hands)
    if (skinSettings.shadow) {
      renderHandShadow(this.shadowGraphics, geom, ppi, pose, keyboardLayout);
    }

    // 3. Render Hand using chosen Skin
    switch (skinSettings.style) {
      case "cartoon":
        renderCartoonSkin(this.handGraphics, geom, skinSettings, ppi);
        break;
      case "gloves":
        renderGlovesSkin(this.handGraphics, geom, skinSettings, ppi);
        break;
      case "robot":
        renderRobotSkin(this.handGraphics, geom, skinSettings, ppi);
        break;
      case "skeleton":
      default:
        renderSkeletonSkin(this.handGraphics, geom, pose, keyboardLayout, skinSettings);
        break;
    }

    if (!showFingerLabels) return;

    // 4. Identify fingertips and render finger labels (1..5)
    const fingerTips = getFingerTipsByFinger(pose);
    if (fingerTips.size > 0) {
      let idx = 0;
      for (const [fingerNum, point] of fingerTips) {
        const p = toScreen(point);

        // Fingertip badge offset towards player (south, down on screen)
        const badgeX = p.x;
        const badgeY = p.y + 16;
        const badgeRadius = 7;

        // Badge background
        this.handGraphics
          .circle(badgeX, badgeY, badgeRadius + 1)
          .fill(accentColor);
        this.handGraphics
          .circle(badgeX, badgeY, badgeRadius)
          .fill(0x18181c);

        // Badge text
        let label = this.labelTextPool[idx];
        if (!label) {
          label = new Text({
            text: "",
            style: {
              fontFamily: "system-ui, sans-serif",
              fontSize: 9,
              fontWeight: "bold",
              fill: 0xffffff,
              align: "center",
            },
          });
          label.anchor.set(0.5, 0.5);
          this.labelsContainer.addChild(label);
          this.labelTextPool.push(label);
        }

        label.text = String(fingerNum);
        label.position.set(badgeX, badgeY);
        label.visible = true;
        idx++;
      }
    }
  }

  public destroy(): void {
    this.shadowGraphics.destroy();
    this.handGraphics.destroy();
    for (const text of this.labelTextPool) {
      text.destroy();
    }
    this.labelsContainer.destroy();
    this.container.destroy();
  }
}

export class HandsView extends Container {
  private motionPlan: MotionPlan | null = null;
  private motionBuffer: MotionBuffer | null = null;
  private keyboardLayout: KeyboardLayout | null = null;
  private skinSettings: SkinSettings;
  private showFingerLabels = true;
  private lastTransportTime = 0;

  private leftPoses: MotionPose[] = [];
  private rightPoses: MotionPose[] = [];

  public readonly leftRenderer = new SingleHandRenderer();
  public readonly rightRenderer = new SingleHandRenderer();

  public constructor(options?: HandsViewOptions) {
    super();
    this.sortableChildren = true;

    this.skinSettings = normalizeSkinSettings(options?.skinSettings);

    this.addChild(this.leftRenderer.container);
    this.addChild(this.rightRenderer.container);

    if (options?.motionPlan) this.setMotionPlan(options.motionPlan);
    if (options?.keyboardLayout) this.setKeyboardLayout(options.keyboardLayout);
    if (options?.motionBuffer !== undefined) this.setMotionBuffer(options.motionBuffer);
  }

  public setMotionBuffer(buffer: MotionBuffer | null): void {
    this.motionBuffer = buffer;
  }

  public getMotionBuffer(): MotionBuffer | null {
    return this.motionBuffer;
  }

  public setSkinSettings(skin: SkinSettings): void {
    this.skinSettings = normalizeSkinSettings(skin);
    this.update(this.lastTransportTime);
  }

  public getSkinSettings(): SkinSettings {
    return this.skinSettings;
  }

  public setShowFingerLabels(show: boolean): void {
    if (this.showFingerLabels === show) return;
    this.showFingerLabels = show;
    this.update(this.lastTransportTime);
  }

  public setMotionPlan(motionPlan: MotionPlan | null): void {
    this.motionPlan = motionPlan;
    this.leftPoses = [];
    this.rightPoses = [];

    if (!motionPlan) {
      this.leftRenderer.clear();
      this.rightRenderer.clear();
      return;
    }

    for (const pose of motionPlan.poses) {
      if (pose.hand === "left") {
        this.leftPoses.push(pose);
      } else {
        this.rightPoses.push(pose);
      }
    }

    this.leftPoses.sort((a, b) => a.transportTimeSeconds - b.transportTimeSeconds);
    this.rightPoses.sort((a, b) => a.transportTimeSeconds - b.transportTimeSeconds);
  }

  public setKeyboardLayout(layout: KeyboardLayout): void {
    this.keyboardLayout = layout;
  }

  public update(transportTime: number): void {
    this.lastTransportTime = transportTime;
    if (!this.keyboardLayout) return;

    const leftPose =
      this.motionBuffer?.samplePose(transportTime, "left") ??
      this.samplePose(this.leftPoses, transportTime);
    const rightPose =
      this.motionBuffer?.samplePose(transportTime, "right") ??
      this.samplePose(this.rightPoses, transportTime);

    // Layer ordering: during crossing episodes, hand with higher layer draws on top
    const leftLayer = leftPose?.layerOrder ?? 0;
    const rightLayer = rightPose?.layerOrder ?? 0;

    if (leftLayer > rightLayer) {
      this.leftRenderer.container.zIndex = 2;
      this.rightRenderer.container.zIndex = 1;
    } else if (rightLayer > leftLayer) {
      this.rightRenderer.container.zIndex = 2;
      this.leftRenderer.container.zIndex = 1;
    } else {
      this.leftRenderer.container.zIndex = 1;
      this.rightRenderer.container.zIndex = 1;
    }

    if (leftPose) {
      this.leftRenderer.render(leftPose, this.keyboardLayout, this.skinSettings, this.showFingerLabels);
      this.leftRenderer.container.visible = true;
    } else {
      this.leftRenderer.clear();
      this.leftRenderer.container.visible = false;
    }

    if (rightPose) {
      this.rightRenderer.render(rightPose, this.keyboardLayout, this.skinSettings, this.showFingerLabels);
      this.rightRenderer.container.visible = true;
    } else {
      this.rightRenderer.clear();
      this.rightRenderer.container.visible = false;
    }
  }

  private samplePose(poses: MotionPose[], time: number): MotionPose | null {
    if (poses.length === 0) return null;
    if (time <= poses[0]!.transportTimeSeconds) return poses[0]!;
    if (time >= poses[poses.length - 1]!.transportTimeSeconds) return poses[poses.length - 1]!;

    // Binary search for surrounding poses
    let lo = 0;
    let hi = poses.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (poses[mid]!.transportTimeSeconds <= time) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const i0 = Math.max(0, lo - 1);
    const i1 = Math.min(poses.length - 1, lo);
    const p0 = poses[i0]!;
    const p1 = poses[i1]!;

    if (i0 === i1) return p0;

    const dt = p1.transportTimeSeconds - p0.transportTimeSeconds;
    if (dt <= 1e-6) return p0;

    const alpha = Math.max(0, Math.min(1, (time - p0.transportTimeSeconds) / dt));
    return lerpPose(p0, p1, alpha);
  }

  public override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.leftRenderer.destroy();
    this.rightRenderer.destroy();
    super.destroy(options);
  }
}
