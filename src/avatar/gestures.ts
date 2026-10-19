/** A head pose offset, each component in -1..1 of the implementation's own range. */
export interface HeadOffset {
  pitch: number;
  yaw: number;
  roll: number;
}

const DURATIONS: Record<string, number> = { nod: 0.8, shake: 1.0, tilt: 1.4 };

/** How long a procedural gesture lasts, or undefined if `name` isn't one. */
export function gestureDuration(name: string): number | undefined {
  return DURATIONS[name];
}

/**
 * The head offset of procedural gesture `name`, `t` seconds in; null once it
 * is over. Shared by VRM (radians) and Live2D (ParamAngle degrees), which
 * scale it to their own range.
 */
export function gestureOffset(name: string, t: number): HeadOffset | null {
  const duration = DURATIONS[name];
  if (duration === undefined || t < 0 || t >= duration) return null;
  const p = t / duration;
  // Eases in and out so the head never jumps.
  const envelope = Math.sin(p * Math.PI);
  switch (name) {
    case "nod":
      // Two dips down (positive pitch = chin down).
      return { pitch: Math.abs(Math.sin(p * Math.PI * 2)) * envelope, yaw: 0, roll: 0 };
    case "shake":
      return { pitch: 0, yaw: Math.sin(p * Math.PI * 4) * envelope, roll: 0 };
    case "tilt":
      return { pitch: 0, yaw: 0, roll: envelope };
    default:
      return null;
  }
}
