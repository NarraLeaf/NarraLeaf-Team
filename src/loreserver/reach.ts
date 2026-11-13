/**
 * Whether loreserver, on this machine, can reach the sign-in address it is given.
 *
 * loreserver connects to the address clients sign in at (see `callbackUrl` in
 * src/identity/config.ts for why it cannot be the loopback). On a machine behind
 * a router that does not do NAT loopback, the public name resolves to an address
 * this machine cannot connect back to, and loreserver's only words for that are
 * `Failed to connect to rebac service`, on every project create, long after
 * startup. Asking once here, before loreserver starts, turns that into a
 * sentence at the moment the operator is watching.
 *
 * A completed TLS handshake, with the certificate deliberately not judged: the
 * question is whether the packets come back, and a name the certificate does
 * not carry is a different problem that should not read as a routing one. The
 * handshake is completed rather than a bare TCP connection dropped, because the
 * listener asked is Team's own and logs every half-open connection as a client
 * that could not complete a handshake.
 */
import { isIP } from "node:net";
import { connect } from "node:tls";

/** How long to wait before calling an address unreachable. */
export const REACH_TIMEOUT_MS = 3000;

/** Whether a TLS handshake with the host and port of `url` completes. */
export function canReach(url: string, timeoutMs = REACH_TIMEOUT_MS): Promise<boolean> {
  const parsed = new URL(url);
  const port = Number(parsed.port || 443);
  // URL keeps the brackets on an IPv6 literal; a socket wants the bare address.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  return new Promise((resolve) => {
    const socket = connect({
      host,
      port,
      // SNI carries names only, and is what picks a supplied certificate.
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: false,
    });
    // A timer of its own rather than socket.setTimeout: that is an idle timer,
    // and it does not run while a name is still being looked up or a TLS socket
    // is waiting for the connection underneath it.
    const timer = setTimeout(() => finish(false), timeoutMs);
    let settled = false;
    function finish(reached: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reached) {
        socket.end();
      } else {
        socket.destroy();
      }
      resolve(reached);
    }
    socket.once("secureConnect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * What to tell an operator whose server cannot reach its own sign-in address.
 *
 * Names the address, the symptom they would otherwise meet, and the change that
 * fixes it, in that order.
 */
export function unreachableNotice(url: string): string {
  const host = new URL(url).hostname;
  return (
    `nlteam: this machine cannot reach ${url}, the address clients sign in at.\n` +
    "        loreserver connects to it too, so every repository call will fail with\n" +
    "        'Failed to connect to rebac service'. Usually the router does not loop a\n" +
    "        public address back to the machine behind it. Make the name resolve to\n" +
    `        this machine here: add '127.0.0.1 ${host}' to /etc/hosts, or in a container\n` +
    `        add '${host}:127.0.0.1' under extra_hosts.\n`
  );
}
