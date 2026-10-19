import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import { closedMouth, type Avatar, type AvatarCapabilities, type LookTarget, type VowelWeights } from "./Avatar";
import { gestureDuration, gestureOffset } from "./gestures";
import type { Vowel } from "../voice/timeline";

/** VRM 1.0 preset names; three-vrm maps VRM 0.x a/i/u/e/o onto these. */
const VOWEL_EXPRESSIONS: Record<Vowel, string> = { a: "aa", i: "ih", u: "ou", e: "ee", o: "oh" };

/** Driven by lip sync, blinking or gaze, so not offered as expressions. */
const RESERVED_EXPRESSIONS = new Set([
  ...Object.values(VOWEL_EXPRESSIONS),
  "blink",
  "blinkLeft",
  "blinkRight",
  "lookUp",
  "lookDown",
  "lookLeft",
  "lookRight",
  "neutral",
]);

const BLINK_SECONDS = 0.15;

/** Head rotation in radians at a gesture's full extent. */
const GESTURE_RANGE = { pitch: 0.25, yaw: 0.35, roll: 0.2 };
/** Head rotation in radians toward a gaze target at the edge of the view. */
const GAZE_RANGE = { yaw: 0.35, pitch: 0.15 };
/** Time constant for the head following a new gaze target. */
const GAZE_SECONDS = 0.3;

/** How far the upper arms drop from the T-pose, in radians. */
const ARM_DROP = 1.2;

/**
 * Z rotation that lowers the left upper arm (the right one is its negation).
 *
 * The normalized rig always rests in a T-pose, but for VRM 0.x it keeps the
 * model's original -Z facing; rotateVRM0 only turns the scene around. X and Z
 * rotations are therefore mirrored on VRM 0.x, and the VRM 1.0 value would
 * raise the arms instead.
 */
export function leftArmRestZ(metaVersion: "0" | "1" | undefined): number {
  return metaVersion === "0" ? ARM_DROP : -ARM_DROP;
}

export class VrmAvatar implements Avatar {
  readonly kind = "vrm";
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private vrm: VRM | null = null;
  private mouth = closedMouth();
  private openness = 0;
  private elapsed = 0;
  private nextBlink = 2;
  /** Expressions set through setExpression, fading toward their targets. */
  private expressions = new Map<string, { value: number; target: number; speed: number }>();
  private gesturePlaying: { name: string; t: number } | null = null;
  /** Where the eyes look; the head follows smoothly. */
  private gaze: LookTarget = { x: 0, y: 0 };
  private head: LookTarget = { x: 0, y: 0 };
  /** What `vrm.lookAt` tracks, placed relative to the camera. */
  private readonly gazeTarget = new THREE.Object3D();

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.container.appendChild(this.renderer.domElement);

    const light = new THREE.DirectionalLight(0xffffff, Math.PI);
    light.position.set(1, 1, 1).normalize();
    this.scene.add(light, new THREE.AmbientLight(0xffffff, 0.4), this.gazeTarget);
    this.resize();
  }

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error("This file is glTF but not VRM.");

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; make it face the camera.
    vrm.scene.traverse((o) => (o.frustumCulled = false));

    this.scene.add(vrm.scene);
    this.vrm = vrm;
    this.relaxArms();
    this.frameUpperBody();
    if (vrm.lookAt) {
      vrm.lookAt.target = this.gazeTarget;
      vrm.lookAt.autoUpdate = true;
    }
    this.placeGazeTarget();
  }

  setMouth(weights: VowelWeights, openness: number): void {
    this.mouth = weights;
    this.openness = openness;
  }

  setExpression(name: string, weight: number, fadeSeconds: number): void {
    const speed = 1 / Math.max(fadeSeconds, 0.01);
    for (const [other, state] of this.expressions) {
      if (other !== name) Object.assign(state, { target: 0, speed });
    }
    if (name === "neutral" || !this.capabilities().expressions.includes(name)) return;
    const state = this.expressions.get(name) ?? { value: 0, target: 0, speed };
    this.expressions.set(name, { ...state, target: Math.min(Math.max(weight, 0), 1), speed });
  }

  gesture(name: string): void {
    if (gestureDuration(name) !== undefined) this.gesturePlaying = { name, t: 0 };
  }

  lookAt(target: LookTarget | null): void {
    this.gaze = target ?? { x: 0, y: 0 };
    this.placeGazeTarget();
  }

  capabilities(): AvatarCapabilities {
    const names = this.vrm?.expressionManager?.expressions.map((e) => e.expressionName) ?? [];
    return {
      expressions: ["neutral", ...names.filter((n) => !RESERVED_EXPRESSIONS.has(n))],
      gestures: ["nod", "shake", "tilt"],
    };
  }

  update(dt: number): void {
    const vrm = this.vrm;
    if (vrm) {
      this.elapsed += dt;
      this.idle();
      this.animateHead(dt);
      const em = vrm.expressionManager;
      if (em) {
        for (const [vowel, name] of Object.entries(VOWEL_EXPRESSIONS) as [Vowel, string][]) {
          em.setValue(name, this.mouth[vowel] * this.openness);
        }
        em.setValue("blink", this.blinkValue());
        for (const [name, state] of this.expressions) {
          const step = state.speed * dt;
          state.value += Math.max(-step, Math.min(step, state.target - state.value));
          em.setValue(name, state.value);
          if (state.value === 0 && state.target === 0) this.expressions.delete(name);
        }
      }
      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const w = Math.max(this.container.clientWidth, 1);
    const h = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Bring the arms down from the T-pose. */
  private relaxArms(): void {
    const h = this.vrm?.humanoid;
    if (!h) return;
    const z = leftArmRestZ(this.vrm?.meta?.metaVersion);
    const left = h.getNormalizedBoneNode("leftUpperArm");
    const right = h.getNormalizedBoneNode("rightUpperArm");
    if (left) left.rotation.z = z;
    if (right) right.rotation.z = -z;
  }

  private frameUpperBody(): void {
    const vrm = this.vrm;
    if (!vrm) return;
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const head = vrm.humanoid.getRawBoneNode("head");
    const y = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.4;
    this.camera.position.set(0, y - 0.1, 1.5);
    this.camera.lookAt(0, y - 0.15, 0);
  }

  /** The gaze target sits next to the camera: screen right is world +x. */
  private placeGazeTarget(): void {
    const { x, y } = this.gaze;
    this.gazeTarget.position.copy(this.camera.position).add(new THREE.Vector3(x * 1.2, y * 0.6, 0));
  }

  /** Breathing and a slow sway so the avatar never looks frozen. */
  private idle(): void {
    const h = this.vrm?.humanoid;
    if (!h) return;
    const t = this.elapsed;
    const spine = h.getNormalizedBoneNode("spine");
    const chest = h.getNormalizedBoneNode("chest");
    const neck = h.getNormalizedBoneNode("neck");
    if (spine) spine.rotation.z = Math.sin(t * 0.7) * 0.02;
    if (chest) chest.rotation.x = Math.sin(t * 2.2) * 0.01;
    if (neck) {
      neck.rotation.y = Math.sin(t * 0.43) * 0.06;
      neck.rotation.x = Math.sin(t * 0.31) * 0.03;
    }
  }

  /** Turns the head toward the gaze target and adds the playing gesture. */
  private animateHead(dt: number): void {
    const k = 1 - Math.exp(-dt / GAZE_SECONDS);
    this.head.x += (this.gaze.x - this.head.x) * k;
    this.head.y += (this.gaze.y - this.head.y) * k;

    let offset = { pitch: 0, yaw: 0, roll: 0 };
    if (this.gesturePlaying) {
      this.gesturePlaying.t += dt;
      const o = gestureOffset(this.gesturePlaying.name, this.gesturePlaying.t);
      if (o) offset = o;
      else this.gesturePlaying = null;
    }

    const head = this.vrm?.humanoid.getNormalizedBoneNode("head");
    if (!head) return;
    // Yaw is the same either way; pitch and roll are mirrored on VRM 0.x (see leftArmRestZ).
    const mirror = this.vrm?.meta?.metaVersion === "0" ? -1 : 1;
    head.rotation.y = this.head.x * GAZE_RANGE.yaw + offset.yaw * GESTURE_RANGE.yaw;
    head.rotation.x = mirror * (-this.head.y * GAZE_RANGE.pitch + offset.pitch * GESTURE_RANGE.pitch);
    head.rotation.z = mirror * offset.roll * GESTURE_RANGE.roll;
  }

  private blinkValue(): number {
    const since = this.elapsed - this.nextBlink;
    if (since < 0) return 0;
    if (since > BLINK_SECONDS) {
      this.nextBlink = this.elapsed + 2 + Math.random() * 4;
      return 0;
    }
    return Math.sin((since / BLINK_SECONDS) * Math.PI);
  }
}
