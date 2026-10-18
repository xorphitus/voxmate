import type { Avatar, AvatarKind } from "./Avatar";

export function avatarKindFor(path: string): AvatarKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".vrm")) return "vrm";
  if (lower.endsWith(".model3.json")) return "live2d";
  return null;
}

/**
 * Builds a URL the asset protocol can serve for an absolute local path.
 *
 * `convertFileSrc` percent-encodes the whole path, slashes included, so
 * relative references inside a model (Live2D textures, motions...) would
 * resolve against the host root. Encoding per segment keeps the directory
 * structure intact; the leading `%2F` survives because the protocol handler
 * strips exactly one `/` before decoding.
 *
 * @param base `convertFileSrc("")`, e.g. `asset://localhost/`
 */
export function assetUrl(base: string, path: string): string {
  const segments = path.replace(/^\/+/, "").split("/").map(encodeURIComponent);
  return `${base}%2F${segments.join("/")}`;
}

/** Implementations are loaded on demand so unused renderers stay out of startup. */
export async function createAvatar(path: string, container: HTMLElement): Promise<Avatar> {
  switch (avatarKindFor(path)) {
    case "vrm": {
      const { VrmAvatar } = await import("./VrmAvatar");
      return new VrmAvatar(container);
    }
    case "live2d": {
      const { Live2DAvatar } = await import("./Live2DAvatar");
      return new Live2DAvatar(container);
    }
    default:
      throw new Error(`Unsupported model file: ${path} (expected .vrm or .model3.json)`);
  }
}
