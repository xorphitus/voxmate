import { describe, expect, it } from "vitest";
import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("uses an explicit preference regardless of the OS", () => {
    expect(resolveTheme("light", "dark", false)).toBe("light");
    expect(resolveTheme("dark", "light", true)).toBe("dark");
  });

  it("follows the window theme for system", () => {
    expect(resolveTheme("system", "light", false)).toBe("light");
    expect(resolveTheme("system", "dark", true)).toBe("dark");
  });

  it("falls back to prefers-color-scheme, then dark", () => {
    expect(resolveTheme("system", null, true)).toBe("light");
    expect(resolveTheme("system", null, false)).toBe("dark");
  });

  it("treats an unknown stored value as system", () => {
    expect(resolveTheme("bogus" as never, "light", false)).toBe("light");
  });
});
