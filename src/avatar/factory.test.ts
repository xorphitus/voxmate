import { describe, expect, it } from "vitest";
import { assetUrl, avatarKindFor } from "./factory";

describe("avatarKindFor", () => {
  it("detects model types by extension", () => {
    expect(avatarKindFor("/models/AvatarSample_A.vrm")).toBe("vrm");
    expect(avatarKindFor("/models/Hiyori/Hiyori.MODEL3.JSON")).toBe("live2d");
    expect(avatarKindFor("/models/old.model.json")).toBeNull();
    expect(avatarKindFor("/models/mesh.glb")).toBeNull();
  });
});

describe("assetUrl", () => {
  const base = "asset://localhost/";

  it("keeps directory structure so relative references resolve", () => {
    const url = assetUrl(base, "/home/me/models/Hiyori/Hiyori.model3.json");
    expect(url).toBe("asset://localhost/%2Fhome/me/models/Hiyori/Hiyori.model3.json");
    expect(new URL("Hiyori.2048/texture_00.png", url).href).toBe(
      "asset://localhost/%2Fhome/me/models/Hiyori/Hiyori.2048/texture_00.png",
    );
  });

  it("encodes special characters within segments", () => {
    expect(assetUrl(base, "/a b/モデル#1.vrm")).toBe(
      "asset://localhost/%2Fa%20b/%E3%83%A2%E3%83%87%E3%83%AB%231.vrm",
    );
  });
});
