/**
 * Entry point of the `nlteam` executable. The build bundles this file into
 * dist/nlteam.js and gives it a `#!/usr/bin/env node` line.
 *
 * Everything here is process wiring; the behaviour lives in ./cli.ts.
 */
import { run } from "./cli.js";

const argv = process.argv.slice(2);

// A command that runs until it is stopped needs to hear about Ctrl-C. Handling
// the signal rather than letting it kill the process is what allows loreserver
// to be shut down before Team exits; installing a handler also suppresses
// node's default of terminating at once, so the handler must always lead to
// the program ending by itself.
const interrupted = new AbortController();
const interrupt = (): void => {
  interrupted.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

// Setting `exitCode` rather than calling `process.exit` lets node drain stdout
// before the process ends. `process.exit` can truncate output when the stream
// is a pipe, which is exactly the case when another program reads --version.
process.exitCode = await run(
  argv,
  (text) => {
    process.stdout.write(text);
  },
  (text) => {
    process.stderr.write(text);
  },
  { signal: interrupted.signal },
);

// Nothing is listening for these any more, and a registered handler would keep
// the process alive after the work is done.
process.off("SIGINT", interrupt);
process.off("SIGTERM", interrupt);
