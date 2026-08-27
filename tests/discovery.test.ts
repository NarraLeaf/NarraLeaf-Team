import { createServer, type Server } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import type { ConnectionOptions } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";

import { unaryCall } from "../src/grpc/client.js";
import { GrpcServer } from "../src/grpc/server.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import {
  DISCOVERY_PATH,
  discoveryDocument,
  serveDiscovery,
  type DiscoveryDocument,
  type DiscoverySource,
} from "../src/identity/discovery.js";
import { identityLayout } from "../src/identity/layout.js";
import { setPublishLineage, setServerName } from "../src/identity/settings.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { webHandler } from "../src/web/router.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-discovery-");

const DOCUMENT: DiscoveryDocument = {
    protocol: 2,
    name: "team.example.lan",
    auth: { required: true, url: "https://team.example.lan:41402" },
    data: { url: "lore://team.example.lan:41337" },
    policy: { publishLineage: "merge" },
    capabilities: ["projects", "project-detail", "members"],
    authority: { sha256: "3D:38:9F:E6" },
    version: "0.1.0",
};

/**
 * Fetch over TLS without checking the certificate.
 *
 * This is about the protocol, not about trust: the endpoint presents a certificate from
 * an authority created seconds ago in a temporary directory, and checking it would test
 * the fixture. What the certificate is worth is `certificates.test.ts`.
 */
function fetchOverTls(port: number, path: string): Promise<{ status: number; body: string; alpn: string }> {
    // Typed as both halves on purpose: `https.request` hands its options to
    // `tls.connect`, so `ALPNProtocols` is honoured, but @types/node describes
    // https.RequestOptions without it and rejects it as an unknown property.
    const options: RequestOptions & ConnectionOptions = {
        host: "127.0.0.1",
        port,
        path,
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
    };
    return new Promise((resolve, reject) => {
        const call = httpsRequest(
            options,
            (response) => {
                // Read while the socket is still attached: by `end` it is detached and null.
                const alpn = (response.socket as { alpnProtocol?: string } | null)?.alpnProtocol ?? "";
                let body = "";
                response.setEncoding("utf-8");
                response.on("data", (chunk: string) => { body += chunk; });
                response.on("end", () => resolve({
                    status: response.statusCode ?? 0,
                    body,
                    alpn,
                }));
            },
        );
        call.on("error", reject);
        call.end();
    });
}

const ECHO_PATH = "/nlteam.test.v1.Echo/Say";

async function endpoint(): Promise<{ port: number; ca: string; stop: () => Promise<void> }> {
    const certificates = await ensureCertificates(await temporaryRoot(), { hostnames: [] });
    const server = await GrpcServer.start({
        port: 0,
        methods: {
            // One method that answers with a message, which is the shape every
            // real one has: the exchanges, the permission question, creating a
            // repository. A service of no methods cannot show that half working.
            [ECHO_PATH]: (call) => call.message,
        },
        tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem },
        http1: (incoming, response) => serveDiscovery(DOCUMENT, incoming, response),
    });
    return { port: server.port, ca: certificates.authority.pem, stop: () => server.close() };
}

describe("the address an author is given", () => {
    it("answers the discovery document over HTTP/1.1 on the endpoint gRPC uses", { timeout: 30_000 }, async () => {
        // The whole point of one address: this is the same listener, the same port and the
        // same certificate the tokens are presented to. A second endpoint would be a second
        // certificate, and therefore a second thing to trust.
        const { port, stop } = await endpoint();
        try {
            const answer = await fetchOverTls(port, DISCOVERY_PATH);
            expect(answer.alpn).toBe("http/1.1");
            expect(answer.status).toBe(200);
            expect(JSON.parse(answer.body)).toEqual(DOCUMENT);
        } finally {
            await stop();
        }
    });

    it("still answers a gRPC call, which is what this listener was for", { timeout: 30_000 }, async () => {
        // Serving HTTP/1.1 here switches node's compatibility layer on for the whole
        // server, and that builds a response object for every h2 stream — including the
        // gRPC ones it never answers. Its `wantTrailers` listener used to send an empty
        // set of trailers before this server sent its own, and the second send threw out
        // of an event handler, which took the process down on the first call that carried
        // a reply. Every method that matters carries one.
        const { port, ca, stop } = await endpoint();
        try {
            const reply = await unaryCall({
                url: `https://127.0.0.1:${String(port)}`,
                path: ECHO_PATH,
                message: Buffer.from([1, 2, 3]),
                ca,
            });
            expect([...reply]).toEqual([1, 2, 3]);
        } finally {
            await stop();
        }
    });

    it("answers nothing else, because this is not a web interface", { timeout: 30_000 }, async () => {
        const { port, stop } = await endpoint();
        try {
            expect((await fetchOverTls(port, "/")).status).toBe(404);
            expect((await fetchOverTls(port, "/.well-known/jwks.json")).status).toBe(404);
        } finally {
            await stop();
        }
    });
});

describe("the name a server answers with", () => {
    const openServers: Server[] = [];
    const openDatabases: DatabaseSync[] = [];

    afterEach(async () => {
        while (openServers.length > 0) {
            const server = openServers.pop();
            await new Promise<void>((resolve) => {
                server?.closeAllConnections();
                server?.close(() => resolve());
            });
        }
        while (openDatabases.length > 0) {
            openDatabases.pop()?.close();
        }
    });

    /** A source over a database of its own, with nothing chosen in it yet. */
    async function source(): Promise<DiscoverySource & { database: DatabaseSync }> {
        const database = await openMigratedDatabase(
            identityLayout(await temporaryRoot()).databasePath,
        );
        openDatabases.push(database);
        return {
            database,
            host: "team.example.lan",
            auth: DOCUMENT.auth,
            data: DOCUMENT.data,
            // Asked for as each document is written, which is what a source is
            // for: part of the answer is a stored setting.
            capabilities: () => DOCUMENT.capabilities,
            authority: DOCUMENT.authority,
            version: DOCUMENT.version,
        };
    }

    /** The listener `up` puts this document on, without the TLS around it. */
    async function serving(from: DiscoverySource): Promise<string> {
        const server = createServer(webHandler(() => discoveryDocument(from), {}));
        openServers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        const { port } = server.address() as AddressInfo;
        return `http://127.0.0.1:${String(port)}`;
    }

    async function nameAt(origin: string): Promise<string> {
        const response = await fetch(`${origin}${DISCOVERY_PATH}`);
        return ((await response.json()) as DiscoveryDocument).name;
    }

    it("is the host this server is reached at, until somebody names it", async () => {
        const from = await source();

        // Measured on a running server before this existed: the document said
        // "127.0.0.1", which is the address the client already had. A name that
        // is the host under a different label gains nobody anything.
        expect(discoveryDocument(from).name).toBe("team.example.lan");
    });

    it("is the name that was chosen", async () => {
        const from = await source();
        setServerName(from.database, "Winterlight");

        expect(discoveryDocument(from).name).toBe("Winterlight");
    });

    it("is the new name on the next request, without anything being restarted", async () => {
        // The whole of the no-restart requirement, asserted rather than assumed.
        // The listener is up and answering throughout; only the row changes.
        const from = await source();
        const origin = await serving(from);

        expect(await nameAt(origin)).toBe("team.example.lan");

        setServerName(from.database, "Winterlight");

        expect(await nameAt(origin)).toBe("Winterlight");

        setServerName(from.database, "Harbour");

        expect(await nameAt(origin)).toBe("Harbour");
    });

    it("changes nothing else about the document", async () => {
        const from = await source();
        setServerName(from.database, "Winterlight");

        // An older client reads the rest of it exactly as it always did.
        expect(discoveryDocument(from)).toEqual({ ...DOCUMENT, name: "Winterlight" });
    });

    it("carries the rule for a repository this server already holds", async () => {
        const from = await source();

        // The default is what a deployment nobody configured says, and it is the
        // answer that loses nothing: the two copies are one project, and the
        // author is given the means to reconcile them.
        expect(discoveryDocument(from).policy).toEqual({ publishLineage: "merge" });

        setPublishLineage(from.database, "refuse");

        // Read as the answer is composed, like the name: a rule changed over ssh
        // reaches the next request rather than the next restart.
        expect(discoveryDocument(from).policy).toEqual({ publishLineage: "refuse" });
    });

    it("says merge where somebody has stored a word that is neither rule", async () => {
        // The file is SQLite and whoever has the storage root can write anything
        // into it. Falling back is right here and wrong for a token lifetime: this
        // is composed into the one document that says where to sign in, so
        // refusing to answer would take that out over a policy with a sane default.
        const from = await source();
        setServerName(from.database, "Winterlight");
        from.database
            .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
            .run("project.publish_lineage", "whatever", 0);

        expect(discoveryDocument(from).policy).toEqual({ publishLineage: "merge" });
    });
});
