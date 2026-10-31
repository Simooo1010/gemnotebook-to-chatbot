// Runs docs/qa/*.qa.test.ts (real adapters vs the fake PostgREST emulator). Usage: npx vitest run --config docs/qa/vitest.qa.config.ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "../.."),
  resolve: { alias: { "@": path.resolve(__dirname, "../../src") } },
  test: { include: ["docs/qa/*.qa.test.ts"], environment: "node", testTimeout: 60_000 },
});
