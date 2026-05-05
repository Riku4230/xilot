import { defineConfig } from "vite";
import { resolve } from "path";

const entry = process.env.ENTRY;

const configs: Record<string, ReturnType<typeof defineConfig>> = {
  content: defineConfig({
    build: {
      outDir: "dist",
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, "src/content/index.ts"),
        name: "content",
        formats: ["iife"],
        fileName: () => "content.js",
      },
    },
  }),
  background: defineConfig({
    build: {
      outDir: "dist",
      emptyOutDir: false,
      lib: {
        entry: resolve(__dirname, "src/background/index.ts"),
        name: "background",
        formats: ["iife"],
        fileName: () => "background.js",
      },
    },
  }),
  sidepanel: defineConfig({
    base: "./",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, "src/sidepanel/index.html"),
        output: {
          entryFileNames: "sidepanel.js",
          assetFileNames: "assets/[name].[ext]",
        },
      },
    },
  }),
};

export default configs[entry || "sidepanel"];
