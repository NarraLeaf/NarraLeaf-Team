/**
 * The Team protocol's wire contract, re-exported from its canonical home.
 *
 * The names on the wire - the frame catalogue, the method names, the capability
 * vocabulary, the error codes, the topic patterns, the limits, the protocol
 * number and the types over them - live in one zero-dependency package,
 * `@narraleaf/team-protocol`, under `protocol/` at the top of this repository.
 * That package is authored once and can be published on its own, so a client
 * that ships separately depends on the same source this server does rather than
 * on a hand-kept copy that drifts.
 *
 * This module exists so that the rest of the server can go on importing the
 * contract from `./protocol.js` while the definitions themselves have moved. It
 * adds nothing of its own: everything here is the package.
 */
export * from "@narraleaf/team-protocol";
