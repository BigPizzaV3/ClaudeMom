import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // macOS 用系统 WebKit：最低 macOS 12（Safari 15），与 Codex++ 同一构建目标。
    target: ["es2020", "safari14", "chrome87", "edge88", "firefox78"],
    cssTarget: ["safari14", "chrome87", "edge88", "firefox78"],
  },
  server: { host: "127.0.0.1", port: 1440, strictPort: true },
});
