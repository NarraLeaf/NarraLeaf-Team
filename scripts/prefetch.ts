/**
 * Put the pinned binaries where a Team server will look, before it needs them.
 *
 * For building an image. A container that downloaded loreserver on first start
 * would fetch a hundred megabytes on every fresh volume, would not start at all
 * on a machine with no route to GitHub, and would make the first thing an
 * operator sees a progress bar rather than a server. So the image is built with
 * both already unpacked, and the running container reaches for them and finds
 * them there.
 *
 * It fills the directory `NLTEAM_CACHE_DIR` names, which is the variable a
 * container sets for exactly this. Nothing here knows a URL or a checksum: it
 * calls what `up` calls, so the digests it verifies against are the ones in
 * src/loreserver/pin.ts and src/lore/pin.ts and there is no second copy of a
 * pin to fall behind.
 *
 * Two things are fetched, and both matter. The binary is what runs; the license
 * and notices beside it are Epic's terms for the program Team installs on your
 * behalf, and an image that redistributes the one without the other is not
 * something to publish. `up` checks for all three, so leaving the text files
 * out would also mean a container that downloads again on first start while
 * appearing to have everything.
 *
 * Not part of the build and not shipped, in the same way as ./bench.ts and
 * ./socket-endpoint.ts beside it:
 *
 *     npx esbuild scripts/prefetch.ts --bundle --platform=node --format=cjs \
 *       --external:koffi --define:__NLTEAM_VERSION__=\"0.0.0-prefetch\" --outfile=prefetch.cjs
 *     NLTEAM_CACHE_DIR=/opt/nlteam/cache node prefetch.cjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureLorelibNotices, LORELIB_VERSION, resolveLorelibArtifact } from "../src/lore/pin.js";
import { ensureInstalled } from "../src/loreserver/install.js";
import { instanceLayout } from "../src/loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "../src/loreserver/pin.js";

async function main(): Promise<void> {
  const cacheDir = process.env["NLTEAM_CACHE_DIR"];
  if (cacheDir === undefined || cacheDir === "") {
    throw new Error(
      "NLTEAM_CACHE_DIR names the directory to fill, and it is not set. Without it this " +
        "would fill the per-user cache of whoever is building the image.",
    );
  }

  const artifact = resolveArtifact();
  console.log(`loreserver ${LORESERVER_VERSION} for ${artifact.target} into ${cacheDir}`);

  // A storage root that does not exist and never will. `instanceLayout` wants
  // one, and every path this fills comes from the cache rather than from it:
  // what a root would hold is one server's files, and this is about a release.
  const nowhere = await mkdtemp(path.join(tmpdir(), "nlteam-prefetch-"));
  try {
    const layout = instanceLayout(nowhere, artifact.binaryName);
    const install = await ensureInstalled(layout, artifact, {
      onFetching: (url) => console.log(`fetching ${url}`),
      onVerifying: (bytes) =>
        console.log(`verifying ${bytes.toLocaleString("en-US")} bytes against the pinned checksum`),
      onExtracting: (binDir) => console.log(`extracting into ${binDir}`),
    });
    console.log(`loreserver is at ${install.binaryPath}`);

    // lorelib itself arrives through npm as one of four platform packages, so
    // what is fetched here is only the license and the notices it is
    // redistributed under. `up` fetches them at run time and forgives a
    // failure; an image has no such excuse, so a failure here stops the build.
    const lorelib = resolveLorelibArtifact();
    if (lorelib === undefined) {
      throw new Error(
        `there is no pinned lorelib for ${process.platform}-${process.arch}, so an image for ` +
          "it could not carry the terms the library is redistributed under",
      );
    }
    const notices = await ensureLorelibNotices(nowhere, lorelib, {
      onFetching: (url) => console.log(`fetching ${url}`),
    });
    console.log(`lorelib ${LORELIB_VERSION}'s license and notices are in ${notices.directory}`);
  } finally {
    await rm(nowhere, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
