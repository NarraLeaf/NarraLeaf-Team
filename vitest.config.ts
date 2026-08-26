import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  resolve: {
    alias: {
      // The wire contract is consumed from source under protocol/ rather than
      // from node_modules; the checker learns this from tsconfig's paths, and
      // the test runner from here.
      "@narraleaf/team-protocol": fileURLToPath(
        new URL("./protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
