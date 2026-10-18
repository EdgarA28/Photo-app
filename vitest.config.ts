import { globSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Each TS package with tests adds its own vitest.config.ts; they are picked up here.
// Vitest errors on an empty project list, so fall back to the root until packages exist.
const projects = globSync("{apps,packages,services}/*/vitest.config.ts");

export default defineConfig({
  test: {
    projects: projects.length > 0 ? projects : undefined,
    passWithNoTests: true,
  },
});
