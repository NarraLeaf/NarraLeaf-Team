import { describe, expect, it } from "vitest";

import {
  INSTANCES_PER_CONNECTION,
  TeamPresence,
  TooManyInstancesError,
} from "../src/team/presence.js";

/**
 * The bookkeeping behind an announcement, tested without a socket.
 *
 * What a client sees of `clients.announce` is covered where the methods are, in
 * tests/team.test.ts. This file is for the accounting underneath it: which
 * connection an id is filed under, and what has to be true for a connection
 * closing to take everything it carried with it. Reaching the limit over a real
 * session would mean sixteen announcements and a seventeenth, which would say
 * nothing more about the rule than calling it here does.
 */
function announcing(id: string) {
  return { id, label: "a window", agent: "studio/0.1" };
}

describe("what a connection is holding", () => {
  it("sweeps an id whose move to another connection was refused", () => {
    const presence = new TeamPresence(() => undefined);
    presence.announce("first", "ada", announcing("her-laptop"));
    for (let index = 0; index < INSTANCES_PER_CONNECTION; index += 1) {
      presence.announce("second", "ada", announcing(`window-${index}`));
    }

    // The same account, so this is not the identity gate: it is one Studio
    // announcing an id it already holds onto a socket that has no room for it.
    expect(() => presence.announce("second", "ada", announcing("her-laptop"))).toThrow(
      TooManyInstancesError,
    );

    // The refusal left the id where it was, which is what makes it possible for
    // the connection carrying it to take it away. An announcement that had
    // detached it first would leave this listing it for ever, on a socket that
    // has closed.
    presence.dropConnection("first");

    expect(presence.clients().map((client) => client.id)).not.toContain("her-laptop");
  });

  it("moves an id to the connection that announced it last", () => {
    const presence = new TeamPresence(() => undefined);
    presence.announce("first", "ada", announcing("her-laptop"));
    presence.announce("second", "ada", announcing("her-laptop"));

    // The socket that used to carry it closing must not take the installation
    // that has moved on, or a Studio that reconnected would go missing the
    // moment its old connection was found dead.
    presence.dropConnection("first");

    expect(presence.clients().map((client) => client.id)).toEqual(["her-laptop"]);
  });
});
