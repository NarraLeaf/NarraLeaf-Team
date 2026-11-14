// Bundles the web console (web/src) into dist/console.
//
// esbuild rather than a second toolchain: it already builds the server, and a
// page of this size needs nothing it lacks. React is bundled in, so the server's
// runtime dependencies stay what they were. Asset names carry a content hash,
// which is what lets src/web/console.ts serve them as immutable.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, "dist", "console");
const assets = join(outdir, "assets");

await rm(outdir, { recursive: true, force: true });
await mkdir(assets, { recursive: true });

const result = await esbuild.build({
  entryPoints: [join(root, "web", "src", "main.tsx")],
  outdir: assets,
  entryNames: "app-[hash]",
  assetNames: "[name]-[hash]",
  bundle: true,
  format: "esm",
  target: ["es2022", "safari16"],
  jsx: "automatic",
  minify: true,
  sourcemap: true,
  metafile: true,
  tsconfig: join(root, "web", "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "linked",
});

const outputs = Object.keys(result.metafile.outputs);
const js = outputs.find((path) => path.endsWith(".js"));
const css = outputs.find((path) => path.endsWith(".css"));
if (js === undefined || css === undefined) {
  throw new Error("the console build produced no script or no stylesheet");
}

const template = await readFile(join(root, "web", "index.html"), "utf8");
await writeFile(
  join(outdir, "index.html"),
  template.replace("%JS%", basename(js)).replace("%CSS%", basename(css)),
);
console.log(`wrote ${outdir}`);
