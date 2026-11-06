import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [vue(), tailwindcss()],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/watch": "http://127.0.0.1:8787",
      "/watches": "http://127.0.0.1:8787",
      "/run": "http://127.0.0.1:8787",
    },
  },
});
