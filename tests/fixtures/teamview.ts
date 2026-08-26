// A Team server with enough going on in it to draw every surface.
//
// Fixed timestamps, and a fixed `now` to measure them against, so that what
// the interface draws is a function of this file and the terminal size and
// nothing else.
import type { TeamView } from "../../src/teamview.js";

const NOW = Date.parse("2026-08-12T14:03:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const FIXTURE_VIEW: TeamView = {
  teamVersion: "0.1.0",
  root: "/srv/team",
  now: NOW,
  server: {
    version: "0.8.6",
    running: true,
    pid: 41288,
    startedAt: NOW - 3 * DAY - 4 * HOUR - 12 * MINUTE,
    restarts: 0,
    healthy: true,
    healthCheckedAt: NOW - 2000,
    storageBytes: 2_576_980_378,
    storageRoot: "/srv/team/loreserver/store",
  },
  reach: {
    signIn: "https://team.example.com:41402",
    data: "lore://team.example.com:41337",
    fingerprint: "SHA256:2f:a1:9c:7d:04:bb:31:e8:5a:c6:90:12:7f:3e:aa:58",
    loopback: [
      { port: 41339, what: "health" },
      { port: 41400, what: "jwks" },
      { port: 41401, what: "authz" },
    ],
  },
  users: [
    {
      username: "ada",
      displayName: "Ada Blackwood",
      email: "ada@example.com",
      role: "owner",
      disabled: false,
      serviceAccount: false,
      createdAt: NOW - 41 * DAY,
      lastSeenAt: NOW - 2 * HOUR,
    },
    {
      username: "bob",
      displayName: "Bob Reyes",
      email: "bob@example.com",
      role: "member",
      disabled: false,
      serviceAccount: false,
      createdAt: NOW - 38 * DAY,
      lastSeenAt: NOW - 3 * HOUR,
    },
    {
      // Disabled, with tokens invalidated, because that combination is what
      // the interface has to keep distinct: one stops the next sign-in, the
      // other refuses the tokens already out there, and an operator who
      // confuses them believes somebody is locked out when they are not.
      username: "cleo",
      displayName: "Cleo Nakamura",
      email: "cleo@example.com",
      role: "member",
      disabled: true,
      serviceAccount: false,
      createdAt: NOW - 39 * DAY,
      lastSeenAt: NOW - 6 * DAY,
      tokensInvalidatedAt: NOW - 6 * DAY,
    },
    {
      username: "ci",
      displayName: "build runner",
      role: "service",
      disabled: false,
      serviceAccount: true,
      createdAt: NOW - 20 * DAY,
      lastSeenAt: NOW - 11 * MINUTE,
    },
  ],
  projects: [
    {
      name: "harbour",
      description: "the one everybody is working on",
      owner: "ada",
      createdAt: Date.parse("2026-07-02T09:14:00Z"),
      history: {
        revisions: 184,
        branch: "main",
        bytes: 2_254_857_830,
        lastAt: NOW - 2 * HOUR,
        lastBy: "ada",
        lastMessage: "Rework the ferry scene",
      },
      file: {
        readable: true,
        title: "A Harbour Tale",
        stageWidth: 1920,
        stageHeight: 1080,
        scenes: 42,
        assets: 1284,
        assetBytes: 2_147_483_648,
        assetsByKind: [
          { kind: "images", count: 903, bytes: 1_503_238_553 },
          { kind: "audio", count: 310, bytes: 566_231_040 },
          { kind: "video", count: 4, bytes: 84_934_656 },
          { kind: "other", count: 67, bytes: 12_582_912 },
        ],
      },
    },
    {
      name: "lighthouse",
      description: "",
      owner: "ada",
      createdAt: Date.parse("2026-07-19T11:02:00Z"),
      history: {
        revisions: 41,
        branch: "main",
        bytes: 325_058_560,
        lastAt: NOW - 26 * HOUR,
        lastBy: "ada",
        lastMessage: "Second draft of the opening",
      },
      file: {
        readable: true,
        title: "Lighthouse",
        stageWidth: 1920,
        stageHeight: 1080,
        scenes: 9,
        assets: 210,
        assetBytes: 314_572_800,
        assetsByKind: [
          { kind: "images", count: 180, bytes: 293_601_280 },
          { kind: "audio", count: 30, bytes: 20_971_520 },
        ],
      },
    },
    {
      name: "tideline",
      description: "",
      owner: "bob",
      createdAt: Date.parse("2026-08-01T16:40:00Z"),
      history: {
        revisions: 7,
        branch: "main",
        bytes: 18_874_368,
        lastAt: NOW - 6 * DAY,
        lastBy: "bob",
        lastMessage: "Start on the harbourmaster",
      },
      // Readable, but a project with nothing in it yet: the counts are real
      // zeroes rather than absent, and must not be drawn as "unknown".
      file: {
        readable: true,
        title: "Tideline",
        stageWidth: 1920,
        stageHeight: 1080,
        scenes: 1,
        assets: 0,
        assetBytes: 0,
        assetsByKind: [],
      },
    },
    {
      // A project created and never pushed to. Everything downstream of a
      // revision is genuinely unknown, and this is the row that catches an
      // interface which renders an empty history as zeroes it made up.
      name: "sandbar",
      description: "",
      owner: "cleo",
      createdAt: Date.parse("2026-08-11T08:05:00Z"),
      history: { revisions: 0 },
      file: { readable: false, reason: "nothing has been pushed to this project yet" },
    },
  ],
  audit: [
    { at: NOW - 49 * MINUTE, username: "ada", resource: "harbour", allowed: true, detail: "owner" },
    { at: NOW - 62 * MINUTE, username: "bob", resource: "harbour", allowed: true, detail: "write" },
    { at: NOW - 5 * MINUTE, username: "cleo", resource: "lighthouse", allowed: false, detail: "no grant" },
    { at: NOW - 6 * MINUTE, username: "ada", resource: "lighthouse", allowed: true, detail: "owner" },
    { at: NOW - 11 * MINUTE, username: "ci", resource: "tideline", allowed: true, detail: "read" },
  ],
  settings: [
    { group: "tokens", label: "sign-in token", value: "30 days", editable: true },
    {
      group: "tokens",
      label: "repository token",
      value: "15 minutes",
      editable: true,
      caution:
        "loreserver accepts this one without asking Team, so revoking access cannot cut it short.",
    },
    { group: "identity", label: "issuer", value: "nlteam", editable: true, restartRequired: true },
    { group: "identity", label: "audience", value: "lore", editable: true, restartRequired: true },
    {
      group: "identity",
      label: "hostnames",
      value: "team.example.com",
      editable: true,
      restartRequired: true,
      caution:
        "A name goes into the certificate and into the audience of every token, so tokens minted before the change may stop being accepted.",
    },
    { group: "loreserver", label: "pinned version", value: "0.8.6", editable: false },
    { group: "loreserver", label: "data port", value: "41337", editable: true, restartRequired: true },
    { group: "loreserver", label: "storage root", value: "/srv/team/loreserver/store", editable: false },
    {
      group: "authority",
      label: "fingerprint",
      value: "SHA256:2f:a1:9c:7d:04:bb:31:e8:5a:c6:90:12:7f:3e:aa:58",
      editable: false,
    },
    { group: "authority", label: "on this machine", value: "trusted", editable: true },
  ],
  signingKeys: 2,
};

/**
 * The same Team, except that the project everybody is looking at was written by
 * a Studio newer than this one.
 *
 * What must survive: the revision history, who may reach it, and the fact that
 * the project exists. What must not happen: an error, an empty panel, or a
 * screen that refuses to draw.
 */
export const FUTURE_SCHEMA_VIEW: TeamView = {
  ...FIXTURE_VIEW,
  projects: FIXTURE_VIEW.projects.map((project) =>
    project.name === "harbour"
      ? {
          ...project,
          file: {
            readable: false,
            reason: "project.json is schema 4; Team reads up to 3",
          },
        }
      : project,
  ),
};
