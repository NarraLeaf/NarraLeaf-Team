/**
 * Closing the TLS listener does not wait on clients that never leave: an upgraded Team socket
 * (a Studio or a console page that is still open) or an idle HTTP/1.1 keep-alive connection. Each
 * used to keep `close()` pending for ever, and with it `nlteam up` after Ctrl-C.
 */
import { connect, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { GrpcServer } from "../src/grpc/server.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-grpcclose-");

function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  return Promise.race([promise, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), ms))]);
}

describe("closing the listener", () => {
  it("does not wait for an upgraded socket or an idle keep-alive connection", async () => {
    const held: Duplex[] = [];
    const certificates = await ensureCertificates(await temporaryRoot(), { hostnames: [] });
    const server = await GrpcServer.start({
      port: 0,
      tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem },
      methods: {},
      http1: (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" });
        response.end("ok");
      },
      upgrade: (_request, socket) => {
        // Taken and kept, as the Team socket keeps every connection it accepts.
        socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
        held.push(socket);
      },
    });

    const open = async (): Promise<TLSSocket> => {
      const socket = connect({ port: server.port, host: "127.0.0.1", ca: certificates.authority.pem, servername: "localhost", ALPNProtocols: ["http/1.1"] });
      await new Promise<void>((resolve) => socket.on("secureConnect", () => resolve()));
      return socket;
    };
    const upgraded = await open();
    upgraded.write(`GET /socket HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n`);
    await new Promise<void>((resolve) => upgraded.once("data", () => resolve()));

    const idle = await open();
    idle.write(`GET / HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: keep-alive\r\n\r\n`);
    await new Promise<void>((resolve) => idle.once("data", () => resolve()));

    expect(held).toHaveLength(1);
    expect(await within(server.close(), 3000)).not.toBe("timed out");
    upgraded.destroy();
    idle.destroy();
  });
});
