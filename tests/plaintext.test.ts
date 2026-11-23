/**
 * A plaintext HTTP request on the TLS port is answered with a redirect to https, not dropped.
 *
 * A browser given an address with no scheme asks for `http://`, and the TLS listener used to
 * close such a connection without a byte: the browser showed ERR_EMPTY_RESPONSE.
 */
import { connect as connectTcp } from "node:net";
import { request } from "node:https";

import { describe, expect, it } from "vitest";

import { GrpcServer } from "../src/grpc/server.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-plaintext-");

/** Send raw bytes and read until the server closes. */
function exchange(port: number, bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ port, host: "127.0.0.1" }, () => socket.write(bytes));
    let answer = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => (answer += chunk));
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });
}

describe("a plaintext request on the TLS port", () => {
  it("is redirected to the same address over https, and https still works", async () => {
    const certificates = await ensureCertificates(await temporaryRoot(), { hostnames: [] });
    const server = await GrpcServer.start({
      port: 0,
      tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem },
      methods: {},
      http1: (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("over tls");
      },
    });
    try {
      const redirect = await exchange(
        server.port,
        `GET /console/?a=1 HTTP/1.1\r\nHost: 192.168.1.100:${server.port}\r\n\r\n`,
      );
      expect(redirect).toMatch(/^HTTP\/1\.1 307 /);
      expect(redirect).toContain(`location: https://192.168.1.100:${server.port}/console/?a=1\r\n`);

      const noHost = await exchange(server.port, "GET / HTTP/1.0\r\n\r\n");
      expect(noHost).toMatch(/^HTTP\/1\.1 400 /);

      const injected = await exchange(server.port, "GET / HTTP/1.1\r\nHost: evil\r\nx: y\r\n\r\n");
      expect(injected).toContain("location: https://evil/\r\n");

      const body = await new Promise<string>((resolve, reject) => {
        const call = request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: "/",
            servername: "localhost",
            ca: certificates.authority.pem,
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (text += chunk));
            response.on("end", () => resolve(text));
          },
        );
        call.on("error", reject);
        call.end();
      });
      expect(body).toBe("over tls");
    } finally {
      await server.close();
    }
  });
});
