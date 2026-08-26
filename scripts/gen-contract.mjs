// Writes protocol/contract.json from the canonical contract module.
//
// The wire names live once, in protocol/src/index.ts, as ordinary TypeScript
// constants. This turns the `CONTRACT` object those constants build into the
// JSON that external tooling and the conformance test read, so there is a JSON
// to compare against without a second hand-authored copy to keep in step. Run it
// whenever the contract changes; the file it writes is generated, not edited.
//
// Node reads the TypeScript source directly (it strips the types), so there is
// nothing to compile first.
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "protocol", "src", "index.ts");
const outfile = join(root, "protocol", "contract.json");

const { CONTRACT } = await import(pathToFileURL(source).href);

// The note goes first, so that anyone who opens the file is told not to edit it
// before they read anything they might be tempted to change.
const document = {
  _generated:
    "This file is generated from protocol/src/index.ts by scripts/gen-contract.mjs. Do not edit it by hand.",
  ...CONTRACT,
};

await writeFile(outfile, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`wrote ${outfile}`);
