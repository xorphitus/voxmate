import { describe, expect, it } from "vitest";
import { leftArmRestZ } from "./VrmAvatar";

describe("leftArmRestZ", () => {
  it("rotates the left arm down with negative Z on VRM 1.0", () => {
    expect(leftArmRestZ("1")).toBeLessThan(0);
  });

  it("mirrors the rotation on VRM 0.x, whose normalized rig faces -Z", () => {
    expect(leftArmRestZ("0")).toBe(-leftArmRestZ("1"));
  });

  it("assumes VRM 1.0 when the meta version is unknown", () => {
    expect(leftArmRestZ(undefined)).toBe(leftArmRestZ("1"));
  });
});
