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
    /** The password was right and a code from the account's authenticator is wanted too. */
    readonly secondFactor = false,
  ) {
    super(message);
  }
}

async function readBody(response: Response): Promise<{ error: string; secondFactor: boolean }> {
  try {
    const body = (await response.json()) as { error?: unknown; secondFactor?: unknown };
    return { error: typeof body.error === "string" ? body.error : response.statusText, secondFactor: body.secondFactor === true };
  } catch {
    return { error: response.statusText, secondFactor: false };
  }
}

async function readError(response: Response): Promise<string> {
  return (await readBody(response)).error;
}

/** Whether every page carries the viewer's name across it, as an operator set. */
export interface Watermark {
  readonly enabled: boolean;
  readonly text?: string;
}

/** Whether this server asks for two-step sign-in, and whether this account has it. */
export interface TwoFactorState {
  readonly required: boolean;
  readonly enabled: boolean;
}

export interface ConsoleSession {
  readonly account: ConsoleAccount;
  readonly watermark: Watermark;
  readonly twoFactor: TwoFactorState;
}

/** The signed-in account and what the server says to draw over it, or undefined when there is no session. */
export async function currentSession(): Promise<ConsoleSession | undefined> {
  const response = await fetch("/api/console/v1/session", { credentials: "same-origin" });
  if (response.status === 401) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as { account: ConsoleAccount; watermark?: Watermark; twoFactor?: TwoFactorState };
  return { account: body.account, watermark: body.watermark ?? { enabled: false }, twoFactor: body.twoFactor ?? { required: false, enabled: false } };
}

/** The signed-in account, or undefined when there is no session. */
export async function currentAccount(): Promise<ConsoleAccount | undefined> {
  return (await currentSession())?.account;
}

export interface SetupForm {
  readonly code: string;
  readonly username: string;
  readonly password: string;
  readonly displayName?: string;
  readonly serverName?: string;
  readonly accent?: string;
}

/** Make the server's first account with the code `up` printed; signs it in. */
export async function setUp(form: SetupForm): Promise<ConsoleAccount> {
  const response = await fetch("/api/console/v1/setup", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(form),
  });
  if (!response.ok) {
    throw new SignInError(await readError(response), response.status);
  }
  return ((await response.json()) as { account: ConsoleAccount }).account;
}

export async function signIn(username: string, password: string, code?: string): Promise<ConsoleAccount> {
  const response = await fetch("/api/console/v1/sign-in", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, ...(code === undefined ? {} : { code }) }),
  });
  if (!response.ok) {
    const body = await readBody(response);
    throw new SignInError(body.error, response.status, body.secondFactor);
  }
  return ((await response.json()) as { account: ConsoleAccount }).account;
}

export async function signOut(): Promise<void> {
  await fetch("/api/console/v1/sign-out", { method: "POST", credentials: "same-origin" });
}
