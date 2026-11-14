/**
 * The console's three HTTP calls: who am I, sign in, sign out. Everything else
 * is on the socket (./socket.ts).
 *
 * The cookie is HttpOnly, so nothing here ever sees it: the browser attaches
 * it, and this file only learns whether it worked.
 */
export interface ConsoleAccount {
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  readonly operator: boolean;
}

export class SignInError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : response.statusText;
  } catch {
    return response.statusText;
  }
}

/** The signed-in account, or undefined when there is no session. */
export async function currentAccount(): Promise<ConsoleAccount | undefined> {
  const response = await fetch("/api/console/v1/session", { credentials: "same-origin" });
  if (response.status === 401) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return ((await response.json()) as { account: ConsoleAccount }).account;
}

export async function signIn(username: string, password: string): Promise<ConsoleAccount> {
  const response = await fetch("/api/console/v1/sign-in", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new SignInError(await readError(response), response.status);
  }
  return ((await response.json()) as { account: ConsoleAccount }).account;
}

export async function signOut(): Promise<void> {
  await fetch("/api/console/v1/sign-out", { method: "POST", credentials: "same-origin" });
}
