import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PORTS,
  instanceLayout,
  renderConfig,
  writeInstance,
  type InstanceLayout,
} from "../src/loreserver/layout.js";
import { LORESERVER_VERSION } from "../src/loreserver/pin.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nlteam-layout-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("instanceLayout", () => {
  it("puts everything about one Team server under the one directory it is given", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    expect(layout.root).toBe(resolve(root));
    // The executable is the exception, and the only one: it belongs to a
    // version rather than to this Team server, and lives in the per-user cache.
    expect(layout.binDir.startsWith(layout.root)).toBe(false);
    expect(layout.binaryPath).toBe(join(layout.binDir, "loreserver"));
    expect(layout.licensePath).toBe(join(layout.binDir, "LICENSE.txt"));
    expect(layout.noticesPath).toBe(join(layout.binDir, "THIRD-PARTY-NOTICES.txt"));
    expect(layout.configDir).toBe(join(layout.root, "loreserver", "config"));
    expect(layout.configPath).toBe(join(layout.configDir, "local.toml"));
    expect(layout.immutableStoreDir).toBe(
      join(layout.root, "loreserver", "store", "immutable"),
    );
    expect(layout.mutableStoreDir).toBe(join(layout.root, "loreserver", "store", "mutable"));
    expect(layout.logPath).toBe(join(layout.root, "logs", "loreserver.log"));
  });

  it("keeps the version in the directory name, so two pins can coexist", async () => {
    const root = await temporaryRoot();

    expect(instanceLayout(root, "loreserver", "0.8.6").binDir).not.toBe(
      instanceLayout(root, "loreserver", "0.9.0").binDir,
    );
  });

  it("asks for the pinned version when nobody names one", async () => {
    // The import that named this constant was here already and nothing used it,
    // which is how the gap was found. It is worth closing: the default and the
    // pin drifting apart would put an installed loreserver in a directory
    // nothing looks in, and the symptom would be a download on every start
    // rather than an error anybody could read.
    const root = await temporaryRoot();

    expect(instanceLayout(root, "loreserver").binDir).toBe(
      instanceLayout(root, "loreserver", LORESERVER_VERSION).binDir,
    );
  });

  it("makes a relative root absolute once, here", () => {
    // loreserver is started with a different working directory in mind than
    // the shell that typed the path; a relative path resolved twice would
    // resolve to two places.
    expect(resolve(instanceLayout("relative-root", "loreserver").root)).toBe(
      resolve("relative-root"),
    );
  });
});

describe("renderConfig", () => {
  /** A layout with fixed paths, so the rendering can be checked exactly. */
  const layout: InstanceLayout = {
    root: "C:\\srv\\team",
    binDir: "C:\\Users\\ada\\AppData\\Local\\nlteam\\cache\\bin\\loreserver-0.8.6",
    binaryPath: "C:\\Users\\ada\\AppData\\Local\\nlteam\\cache\\bin\\loreserver-0.8.6\\loreserver.exe",
    licensePath: "C:\\Users\\ada\\AppData\\Local\\nlteam\\cache\\bin\\loreserver-0.8.6\\LICENSE.txt",
    noticesPath:
      "C:\\Users\\ada\\AppData\\Local\\nlteam\\cache\\bin\\loreserver-0.8.6\\THIRD-PARTY-NOTICES.txt",
    stored: {
      binDir: "C:\\srv\\team\\bin\\loreserver-0.8.6",
      binaryPath: "C:\\srv\\team\\bin\\loreserver-0.8.6\\loreserver.exe",
      licensePath: "C:\\srv\\team\\bin\\loreserver-0.8.6\\LICENSE.txt",
      noticesPath: "C:\\srv\\team\\bin\\loreserver-0.8.6\\THIRD-PARTY-NOTICES.txt",
    },
    configDir: "C:\\srv\\team\\loreserver\\config",
    configPath: "C:\\srv\\team\\loreserver\\config\\local.toml",
    immutableStoreDir: "C:\\srv\\team\\loreserver\\store\\immutable",
    mutableStoreDir: "C:\\srv\\team\\loreserver\\store\\mutable",
    logDir: "C:\\srv\\team\\logs",
    logPath: "C:\\srv\\team\\logs\\loreserver.log",
  };

  it("writes the tables and keys loreserver reads", () => {
    expect(renderConfig(layout, { dataPort: 41337, healthPort: 41339 })).toBe(
      [
        "[immutable_store.local]",
        'path = "C:/srv/team/loreserver/store/immutable"',
        "[mutable_store.local]",
        'path = "C:/srv/team/loreserver/store/mutable"',
        "[server.grpc]",
        "port = 41337",
        "[server.quic]",
        "port = 41337",
        "[server.http]",
        "port = 41339",
        "",
      ].join("\n"),
    );
  });

  it("gives gRPC and QUIC the same port, and the health check a different one", () => {
    const toml = renderConfig(layout, { dataPort: 5000, healthPort: 5001 });

    // One number on TCP and UDP is deliberate; two listeners on one TCP port
    // would not be.
    expect(toml).toContain("[server.grpc]\nport = 5000");
    expect(toml).toContain("[server.quic]\nport = 5000");
    expect(toml).toContain("[server.http]\nport = 5001");
  });

  it("writes paths with forward slashes, which TOML does not treat as escapes", () => {
    const toml = renderConfig(layout, DEFAULT_PORTS);

    // A backslash inside a TOML basic string begins an escape sequence, so a
    // Windows path written verbatim would be a different path or a parse error.
    expect(toml).not.toContain("\\");
  });
});

describe("renderConfig, with identity switched on", () => {
  const layout = instanceLayout("/srv/team", "loreserver");
  const auth = {
    issuer: "narraleaf-team",
    audience: ["loreserver"],
    jwksUrl: "http://127.0.0.1:41400/.well-known/jwks.json",
    // The loopback, and not the address a client is told to sign in at. These
    // were one value until a deployment people outside the building could reach
    // showed what it cost: loreserver had to leave the machine and come back.
    callbackUrl: "https://127.0.0.1:41402",
  };

  it("writes both blocks, because one on its own fails as a client bug", () => {
    const toml = renderConfig(layout, DEFAULT_PORTS, auth);

    // [server.auth] alone makes the server demand a token while the client is
    // never told there is anywhere to get one.
    expect(toml).toContain(
      [
        "[server.auth]",
        'jwt_issuer = "narraleaf-team"',
        'jwt_audience = ["loreserver"]',
        "[server.auth.jwk]",
        'endpoint = "http://127.0.0.1:41400/.well-known/jwks.json"',
      ].join("\n"),
    );
    expect(toml).toContain(
      ["[environment.endpoint]", 'auth_url = "https://127.0.0.1:41402"'].join("\n"),
    );
  });

  it("writes jwt_audience as an array, which is the only form that starts", () => {
    const toml = renderConfig(layout, DEFAULT_PORTS, { ...auth, audience: ["one", "two"] });

    expect(toml).toContain('jwt_audience = ["one", "two"]');
    // A bare string there makes loreserver refuse to start.
    expect(toml).not.toMatch(/jwt_audience = "/);
  });

  it("keeps the stores and the ports where they were", () => {
    const withAuth = renderConfig(layout, DEFAULT_PORTS, auth);

    expect(withAuth.startsWith(renderConfig(layout, DEFAULT_PORTS).trimEnd())).toBe(true);
  });

  it("writes the file it always did when identity is off", () => {
    // The no-identity path is what every existing installation runs.
    expect(renderConfig(layout, DEFAULT_PORTS)).not.toContain("[server.auth]");
    expect(renderConfig(layout, DEFAULT_PORTS)).not.toContain("[environment.endpoint]");
  });

  it("escapes a value rather than letting it end the string early", () => {
    const toml = renderConfig(layout, DEFAULT_PORTS, { ...auth, issuer: 'a"b\\c' });

    expect(toml).toContain('jwt_issuer = "a\\"b\\\\c"');
  });
});

describe("writeInstance", () => {
  it("creates the directories loreserver needs and writes its config", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    await writeInstance(layout, DEFAULT_PORTS);

    for (const directory of [
      layout.configDir,
      layout.immutableStoreDir,
      layout.mutableStoreDir,
      layout.logDir,
    ]) {
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
    expect(await readFile(layout.configPath, "utf8")).toBe(
      renderConfig(layout, DEFAULT_PORTS),
    );
  });

  it("writes the auth blocks it is given, and none when it is given none", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    await writeInstance(layout, DEFAULT_PORTS, {
      issuer: "narraleaf-team",
      audience: ["loreserver"],
      jwksUrl: "http://127.0.0.1:41400/.well-known/jwks.json",
      callbackUrl: "https://127.0.0.1:41402",
    });
    expect(await readFile(layout.configPath, "utf8")).toContain('jwt_audience = ["loreserver"]');

    await writeInstance(layout, DEFAULT_PORTS);
    expect(await readFile(layout.configPath, "utf8")).not.toContain("[server.auth]");
  });

  it("replaces a config left over from a run with different ports", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    await writeInstance(layout, { dataPort: 41337, healthPort: 41339 });
    await writeInstance(layout, { dataPort: 5000, healthPort: 5001 });

    const toml = await readFile(layout.configPath, "utf8");
    expect(toml).toContain("port = 5000");
    expect(toml).not.toContain("41337");
  });
});
