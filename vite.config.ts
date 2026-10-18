/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WebKitGTK / WKWebView on supported platforms handle ES2021 fine.
    target: "es2021",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // A local desktop app: the three/pixi chunks are big but load from disk.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
