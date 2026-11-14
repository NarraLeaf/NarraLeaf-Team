/**
 * How far away this server is: `server.ping` answers at once with the server's clock.
 *
 * The connection's own keepalive is WebSocket ping and pong control frames, which a browser never
 * shows to the page. A client that wants to show its latency times this call instead: the time
 * from sending it to reading the answer is the round trip, over the same socket every other call
 * takes. It reads nothing and writes nothing, so asking every few seconds costs nothing.
 */
import { MethodError, paramsObject, type MethodContext, type TeamMethod } from "../methods.js";
import { TEAM_METHODS } from "../protocol.js";

export function serverMethods(): TeamMethod[] {
  return [
    {
      name: TEAM_METHODS.serverPing,
      capability: "session",
      handle: (params: unknown, _context: MethodContext) => {
        const read = params === undefined ? {} : paramsObject(params);
        const sent = read["sent"];
        if (sent !== undefined && (typeof sent !== "number" || !Number.isFinite(sent))) {
          throw new MethodError("bad-params", "sent has to be a number");
        }
        return { at: Date.now(), ...(sent === undefined ? {} : { sent }) };
      },
    },
  ];
}
