/**
 * The Team socket, from a browser.
 *
 * The same protocol Studio speaks, opened with the console's cookie instead of
 * a bearer: the browser attaches the cookie and the page's origin to the
 * handshake, and the server checks both (src/team/endpoint.ts). One call is a
 * promise; one subscription is a callback.
 */
import {
  TEAM_SOCKET_PATH,
  type TeamErrorCode,
  type TeamHelloFrame,
  type TeamServerFrame,
} from "@narraleaf/team-protocol";

export class CallError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "open"; readonly hello: TeamHelloFrame }
  | { readonly kind: "closed"; readonly reason: string; readonly signedOut: boolean };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class TeamConnection {
  private ws: WebSocket | undefined;
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly topics = new Map<string, Set<(payload: unknown) => void>>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private current: ConnectionState = { kind: "connecting" };
  private retry: number | undefined;
  private attempts = 0;
  private stopped = false;

  get state(): ConnectionState {
    return this.current;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== undefined) {
      window.clearTimeout(this.retry);
    }
    this.ws?.close();
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.current);
    return () => this.stateListeners.delete(listener);
  }

  call<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (ws === undefined || this.current.kind !== "open") {
      return Promise.reject(new CallError("unavailable", "not connected"));
    }
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      ws.send(JSON.stringify({ t: "call", id, method, ...(params === undefined ? {} : { params }) }));
    });
  }

  /** Hear about a topic. Subscribes on the first listener and again after every reconnect. */
  subscribe(topic: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.topics.get(topic);
    if (listeners === undefined) {
      listeners = new Set();
      this.topics.set(topic, listeners);
      this.sendSubscribe(topic);
    }
    listeners.add(listener);
    return () => {
      const held = this.topics.get(topic);
      held?.delete(listener);
      if (held !== undefined && held.size === 0) {
        this.topics.delete(topic);
        if (this.current.kind === "open") {
          this.ws?.send(JSON.stringify({ t: "unsubscribe", id: this.next++, topic }));
        }
      }
    };
  }

  private sendSubscribe(topic: string): void {
    if (this.current.kind === "open") {
      this.ws?.send(JSON.stringify({ t: "subscribe", id: this.next++, topic }));
    }
  }

  private setState(state: ConnectionState): void {
    this.current = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }

  private open(): void {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${window.location.host}${TEAM_SOCKET_PATH}`);
    this.ws = ws;
    this.setState({ kind: "connecting" });
    let signedOut = false;

    ws.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as TeamServerFrame;
      switch (frame.t) {
        case "hello":
          this.attempts = 0;
          this.setState({ kind: "open", hello: frame });
          for (const topic of this.topics.keys()) {
            this.sendSubscribe(topic);
          }
          return;
        case "result":
          this.pending.get(frame.id)?.resolve(frame.value);
          this.pending.delete(frame.id);
          return;
        case "error":
          this.pending.get(frame.id)?.reject(new CallError(frame.code, frame.message));
          this.pending.delete(frame.id);
          return;
        case "event":
          for (const listener of this.topics.get(frame.topic) ?? []) {
            listener(frame.payload);
          }
          return;
        case "bye":
          signedOut = frame.code === "unauthenticated";
          return;
        default:
          return;
      }
    };
    ws.onclose = () => {
      for (const pending of this.pending.values()) {
        pending.reject(new CallError("unavailable", "the connection closed"));
      }
      this.pending.clear();
      this.setState({ kind: "closed", reason: "closed", signedOut });
      if (this.stopped || signedOut) {
        return;
      }
      // Back off to half a minute; a server restarting is the ordinary case.
      const delay = Math.min(30_000, 500 * 2 ** this.attempts);
      this.attempts += 1;
      this.retry = window.setTimeout(() => this.open(), delay);
    };
  }
}
