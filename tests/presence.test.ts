import { describe, expect, it } from "vitest";

import {
  INSTANCES_PER_CONNECTION,
  TeamPresence,
  TooManyInstancesError,
} from "../src/team/presence.js";
import { liveTopic } from "../src/team/protocol.js";

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

describe("what a room leaves behind it", () => {
  /** A presence that writes down every topic it was told to stop counting. */
  function watching(): { presence: TeamPresence; retired: string[] } {
    const retired: string[] = [];
    const presence = new TeamPresence(
      () => undefined,
      (topic) => {
        retired.push(topic);
      },
    );
    return { presence, retired };
  }

  const room = {
    project: "a-project",
    revision: "r1",
    story: "editor/story/stories/one/storydoc.json",
  };

  it("retires its own topic when it is closed, and not the project's", () => {
    const { presence, retired } = watching();
    const her = presence.announce("hers", "ada", {
      ...announcing("her-laptop"),
      project: room.project,
    });
    const opened = presence.open(her, room);

    // Nothing is retired while it is open: the room is still a thing a client
    // can subscribe to and be told about.
    expect(retired).toEqual([]);

    expect(presence.close(her.id, opened.session.id)).toBe(true);

    // A session id is minted per room and never used again, so its count is
    // worth nothing the moment the room is over. The project's topics are not
    // here, because the project has not gone anywhere.
    expect(retired).toEqual([liveTopic(opened.session.id)]);
  });

  it("retires it when the last window goes as well as when it is closed", () => {
    const { presence, retired } = watching();
    const her = presence.announce("hers", "ada", {
      ...announcing("her-laptop"),
      project: room.project,
    });
    const opened = presence.open(her, room);

    // Every way out of a room leads to the same place, so a socket closing has
    // to leave as little behind as pressing the button does.
    presence.dropConnection("hers");

    expect(retired).toEqual([liveTopic(opened.session.id)]);
  });
});
