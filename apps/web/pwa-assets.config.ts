import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// PWA icons (9.1, FR-PWA-1, §12.5), generated from public/logo.svg by vite-plugin-pwa at
// dev and build time (nothing committed): favicon.ico, pwa-64/192/512, maskable-icon-512 and
// apple-touch-icon-180. The SVG is already full-bleed with its content in the safe zone, so the
// preset's padding is turned off for every variant.
export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    ...minimal2023Preset,
    transparent: { ...minimal2023Preset.transparent, padding: 0 },
    maskable: { ...minimal2023Preset.maskable, padding: 0 },
    apple: { ...minimal2023Preset.apple, padding: 0 },
  },
  images: ["public/logo.svg"],
});
