import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Stage 1 is offline by construction: nothing here may touch the network.
    testTimeout: 10_000,
  },
});
