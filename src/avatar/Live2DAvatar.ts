import * as PIXI from "pixi.js";
import type { Live2DModel } from "pixi-live2d-display/cubism4";
import { closedMouth, type Avatar, type VowelWeights } from "./Avatar";
import { VOWELS, type Vowel } from "../voice/timeline";

/**
 * Cubism Core can't be redistributed, so it isn't bundled. Users put it in
 * public/lib/ (see README) and it's loaded at runtime from there.
 */
const CUBISM_CORE_URL = "/lib/live2dcubismcore.min.js";

export class CubismCoreMissingError extends Error {
  constructor() {
    super(
      "Live2D Cubism Core was not found. Download the Cubism SDK for Web from " +
        "https://www.live2d.com/sdk/download/web/ and copy Core/live2dcubismcore.min.js " +
        "to public/lib/ (see README).",
    );
    this.name = "CubismCoreMissingError";
  }
}

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
  }
}

let coreLoading: Promise<void> | null = null;

export function ensureCubismCore(): Promise<void> {
  if (window.Live2DCubismCore) return Promise.resolve();
  coreLoading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CUBISM_CORE_URL;
    script.onload = () => (window.Live2DCubismCore ? resolve() : reject(new CubismCoreMissingError()));
    script.onerror = () => reject(new CubismCoreMissingError());
    document.head.appendChild(script);
  }).catch((e) => {
    coreLoading = null;
    throw e;
  });
  return coreLoading;
}

/** [ParamMouthOpenY, ParamMouthForm] per vowel. */
const MOUTH_SHAPES: Record<Vowel, [open: number, form: number]> = {
  a: [1.0, 0],
  i: [0.3, 1],
  u: [0.3, -1],
  e: [0.5, 0.5],
  o: [0.7, -0.5],
};

/** Mixes vowel weights into Live2D mouth parameters. */
export function mouthParams(weights: VowelWeights, openness: number): { open: number; form: number } {
  let open = 0;
  let form = 0;
  let total = 0;
  for (const v of VOWELS) {
    const w = weights[v];
    open += w * MOUTH_SHAPES[v][0];
    form += w * MOUTH_SHAPES[v][1];
    total += w;
  }
  return {
    open: Math.min(open * openness, 1),
    form: total > 1e-4 ? form / total : 0,
  };
}

interface CoreModel {
  setParameterValueById(id: string, value: number, weight?: number): void;
}

export class Live2DAvatar implements Avatar {
  readonly kind = "live2d";
  private app: PIXI.Application<HTMLCanvasElement>;
  private model: Live2DModel | null = null;
  private mouth = closedMouth();
  private openness = 0;

  constructor(container: HTMLElement) {
    this.app = new PIXI.Application<HTMLCanvasElement>({
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      resizeTo: container,
    });
    container.appendChild(this.app.view);
  }

  async load(url: string): Promise<void> {
    await ensureCubismCore();
    // Imported lazily: the module throws at import time without Cubism Core.
    const { Live2DModel } = await import("pixi-live2d-display/cubism4");
    const model = await Live2DModel.from(url, {
      autoUpdate: false, // driven from update(dt)
      autoHitTest: false,
      autoFocus: false,
    });

    const internal = model.internalModel as unknown as {
      coreModel: CoreModel;
      motionManager: { lipSyncIds?: string[] };
      on(event: "beforeModelUpdate", fn: () => void): void;
    };
    const openIds = internal.motionManager.lipSyncIds?.length
      ? internal.motionManager.lipSyncIds
      : ["ParamMouthOpenY"];
    // Runs after motions/physics are applied, so the mouth wins over idle motion.
    internal.on("beforeModelUpdate", () => {
      const { open, form } = mouthParams(this.mouth, this.openness);
      for (const id of openIds) internal.coreModel.setParameterValueById(id, open);
      internal.coreModel.setParameterValueById("ParamMouthForm", form);
    });

    this.app.stage.addChild(model);
    this.model = model;
    this.resize();
  }

  setMouth(weights: VowelWeights, openness: number): void {
    this.mouth = weights;
    this.openness = openness;
  }

  update(dt: number): void {
    this.model?.update(dt * 1000);
  }

  resize(): void {
    const model = this.model;
    if (!model) return;
    this.app.resize();
    const { width, height } = this.app.screen;
    const { width: mw, height: mh } = model.internalModel;
    // Fit the whole model, slightly inset.
    const scale = Math.min(width / mw, height / mh) * 0.95;
    model.scale.set(scale);
    model.anchor.set(0.5, 0.5);
    model.position.set(width / 2, height / 2);
  }

  dispose(): void {
    this.model = null;
    this.app.destroy(true, { children: true, texture: true, baseTexture: true });
  }
}
