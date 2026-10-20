import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    worker: "src/worker.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
});
