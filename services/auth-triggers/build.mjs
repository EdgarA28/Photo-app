// Bundles the pre-sign-up Lambda into dist/index.mjs (Node.js 22, arm64; spec §4, §11.3).
// The AWS SDK is bundled instead of using the runtime's copy, so the deployed version is the
// locked one.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: "linked",
  legalComments: "none",
  // Some CommonJS dependencies call require(); give the ESM bundle a working one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
