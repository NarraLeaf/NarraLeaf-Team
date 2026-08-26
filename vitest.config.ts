import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// The bundler replaces __NLTEAM_VERSION__ with the version from package.json
// (see scripts/build.mjs). Tests import the same source files, so the identifier
// has to be substituted here too, from the same place, or nothing that reaches
// src/version.ts could run.
const manifest: { version: string } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  define: {
    __NLTEAM_VERSION__: JSON.stringify(manifest.version),
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
