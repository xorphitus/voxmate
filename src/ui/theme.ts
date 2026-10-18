import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";

export type ThemePreference = "system" | Theme;

/**
 * The window's theme is preferred over `prefers-color-scheme` because
 * WebKitGTK does not always pass the desktop theme through to CSS. Dark is the
 * fallback, matching the default tokens in styles.css.
 */
export function resolveTheme(preference: ThemePreference, windowTheme: Theme | null, mediaLight: boolean): Theme {
  if (preference === "light" || preference === "dark") return preference;
  return windowTheme ?? (mediaLight ? "light" : "dark");
}

/** Sets `data-theme` on <html> and keeps it in sync with the OS. Returns a re-apply function. */
export async function followTheme(preference: () => ThemePreference): Promise<() => void> {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const win = getCurrentWindow();
  let windowTheme = await win.theme().catch(() => null);
  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(preference(), windowTheme, media.matches);
  };
  await win.onThemeChanged(({ payload }) => {
    windowTheme = payload;
    apply();
  });
  media.addEventListener("change", apply);
  apply();
  return apply;
}
