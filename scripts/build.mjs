// Bundles src/nlteam.ts into dist/nlteam.js.
//
// One pass. The version number goes in as a string literal, so the finished
// executable carries its own and never has to work out where it is on disk in
// order to answer for itself — which is the thing that breaks once a file has
// been copied, symlinked or installed onto a PATH.
//
// Not a self-contained file, and it cannot be one. Reading a repository needs
// koffi, which is a native addon, and lorelib, which is a 29.5 MB shared
// library that arrives as one of four platform packages. Neither can live
// inside a JavaScript bundle, so both are left external and found at runtime
// in node_modules — which is there for `npm i -g`, for a checkout, and inside a
// container. What is no longer possible is copying one file somewhere and
// running it.
//
// Run with `--watch` to rebuild whenever a source file changes.
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, "dist", "nlteam.js");

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/**
 * Everything the executable is built from.
 *
 * @returns {import("esbuild").BuildOptions}
 */
function serverOptions() {
  return {
  entryPoints: [join(root, "src", "nlteam.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  // The two that cannot be bundled, for the reason at the top of this file.
  // The platform packages are named as a group because exactly one of the four
  // is ever installed — each declares the os and cpu it is for — and a build on
  // one machine must not decide which one the finished file may look for.
  external: ["koffi", "@lore-vcs/*"],
  // The line a shell needs to run the file directly. It is here rather than in
  // the TypeScript source so that the checker and the test runner never have to
  // make sense of a line that is not JavaScript.
  banner: { js: "#!/usr/bin/env node" },
  // Replaces the identifier throughout the bundle with a literal, so the
  // finished executable carries its own version number. src/version.ts explains
  // why the number is not read from disk at startup.
    define: {
      __NLTEAM_VERSION__: JSON.stringify(manifest.version),
    },
  };
}

/**
 * Give the output the owner-execute bit, so that a POSIX shell will run
 * dist/nlteam.js through the shebang line. Windows ignores the mode; the call
 * still succeeds there, so it needs no guard.
 */
async function makeExecutable() {
  await chmod(outfile, 0o755);
}

/** Start watching the executable's own sources, and write it once now. */
async function startServerContext() {
  const context = await esbuild.context({
    ...serverOptions(),
    plugins: [
      {
        name: "chmod-output",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length === 0) {
              await makeExecutable();
            }
          });
        },
      },
    ],
  });
  await context.watch();
  return context;
}

if (process.argv.includes("--watch")) {
  await startServerContext();
  console.log(`watching for changes; writing ${outfile}`);
} else {
  await esbuild.build(serverOptions());
  await makeExecutable();
  console.log(`wrote ${outfile}`);
}
