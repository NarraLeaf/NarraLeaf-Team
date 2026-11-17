/**
 * The console's socket hears a project's topics under the project's id, even when the page's
 * address named the project by its address: the server names those topics by id only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static last: FakeSocket | undefined;
  readonly sent: { t: string; topic?: string }[] = [];
  onmessage: ((message: { data: string }) => void) | undefined;
  onclose: (() => void) | undefined;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as { t: string; topic?: string });
  }
  close(): void {}
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  topics(kind: "subscribe" | "unsubscribe"): (string | undefined)[] {
    return this.sent.filter((frame) => frame.t === kind).map((frame) => frame.topic);
  }
}

vi.stubGlobal("WebSocket", FakeSocket);
vi.stubGlobal("window", { location: { protocol: "http:", host: "team.invalid" }, setTimeout, clearTimeout });

// The console's socket is written for a browser, and this package's checker has no DOM: the module
// is loaded by a path the checker does not follow, and described here by the part these tests use.
interface Connection {
  start(): void;
  subscribe(topic: string, listener: (payload: unknown) => void): () => void;
  nameProject(address: string, id: string): void;
}
const socketModule = "../web/src/socket.js";
const { TeamConnection } = (await import(socketModule)) as { TeamConnection: new () => Connection };

function opened(): { connection: Connection; socket: FakeSocket } {
  const connection = new TeamConnection();
  connection.start();
  const socket = FakeSocket.last!;
  socket.receive({ t: "hello" });
  return { connection, socket };
}

afterEach(() => {
  FakeSocket.last = undefined;
});

describe("a project named by its address", () => {
  it("is subscribed again under its id once that is known, and hears what is published there", () => {
    const { connection, socket } = opened();
    const heard: unknown[] = [];
    const stop = connection.subscribe("project:my-story/chat", (payload) => heard.push(payload));
    expect(socket.topics("subscribe")).toEqual(["project:my-story/chat"]);

    connection.nameProject("my-story", "abc123");
    expect(socket.topics("subscribe")).toEqual(["project:my-story/chat", "project:abc123/chat"]);

    socket.receive({ t: "event", topic: "project:abc123/chat", seq: 1, payload: { kind: "reaction" } });
    expect(heard).toEqual([{ kind: "reaction" }]);

    stop();
    expect(socket.topics("unsubscribe")).toContain("project:abc123/chat");
  });

  it("subscribes under the id from the start once the address is known, and once for both names", () => {
    const { connection, socket } = opened();
    connection.nameProject("my-story", "abc123");
    const heard: string[] = [];
    const byAddress = connection.subscribe("project:my-story/threads", () => heard.push("address"));
    const byId = connection.subscribe("project:abc123/threads", () => heard.push("id"));
    expect(socket.topics("subscribe")).toEqual(["project:abc123/threads"]);

    socket.receive({ t: "event", topic: "project:abc123/threads", seq: 1, payload: {} });
    expect(heard.sort()).toEqual(["address", "id"]);

    byAddress();
    expect(socket.topics("unsubscribe")).toEqual([]);
    byId();
    expect(socket.topics("unsubscribe")).toEqual(["project:abc123/threads"]);
  });

  it("leaves every other topic as it is, and asks again under the id after a reconnect", () => {
    const { connection, socket } = opened();
    connection.subscribe("projects", () => undefined);
    connection.subscribe("project:my-story", () => undefined);
    connection.nameProject("my-story", "abc123");
    socket.receive({ t: "hello" });
    expect(socket.topics("subscribe").slice(-2).sort()).toEqual(["project:abc123", "projects"]);
  });
});
