/**
 * Everything the web interface says, as a shape a language has to fill in.
 *
 * There is no lookup by string key here and no template syntax. A message is a
 * field, and one that needs a value is a function of exactly the values it
 * needs, so a catalogue that is missing a message or that forgot a name inside
 * one does not compile. The alternative — `t("action.granted", {...})` — moves
 * every one of those mistakes to the moment somebody in Tokyo presses a button.
 *
 * Both halves import this. The page draws from it and the server composes the
 * sentence an action answers with from it, which is what keeps a Chinese page
 * from being a Chinese frame around English sentences.
 *
 * What is **not** here is anything the server recorded rather than said: a
 * username, a project's name, the `detail` of a decision the authorization
 * service wrote down, the name of a group. Those are data. Translating them
 * would mean a page that no longer shows what is in the database.
 */
import type { Locale } from "./locales.js";

/** The units a duration is written in. */
export type DurationUnit = "day" | "hour" | "minute" | "second";

/** Turning numbers and moments into words. */
export interface FormatMessages {
  /**
   * What is drawn where a value is missing.
   *
   * One word everywhere, because the alternative is a screen where a blank cell
   * sometimes means nothing and sometimes means Team could not work it out.
   */
  readonly unknown: string;
  readonly never: string;
  readonly justNow: string;
  readonly secondsAgo: (seconds: number) => string;
  readonly minutesAgo: (minutes: number) => string;
  readonly hoursAgo: (hours: number) => string;
  readonly yesterday: string;
  readonly daysAgo: (days: number) => string;
  /** `30 days`, `30 天`, `30日`. */
  readonly duration: (amount: number, unit: DurationUnit) => string;
  /**
   * The words this language writes a duration with, and what each one means.
   *
   * Read back rather than only written: the editor on the settings surface
   * opens on the words a person is reading, so those exact words have to be
   * accepted when they are handed back. Every locale also accepts `7d`, which
   * is what the command line takes.
   *
   * Longest first, so that a language whose word for an hour contains its word
   * for a day cannot have the shorter one matched inside the longer.
   */
  readonly durationWords: ReadonlyArray<readonly [string, "d" | "h" | "m" | "s"]>;
}

/** The words on screen, by the surface they are on. */
export interface PageMessages {
  readonly nav: {
    readonly overview: string;
    readonly projects: string;
    readonly members: string;
    readonly decisions: string;
    readonly settings: string;
  };
  readonly gate: {
    readonly username: string;
    readonly password: string;
    readonly signIn: string;
  };
  readonly shell: {
    readonly signOut: string;
    readonly dismiss: string;
    readonly reconnecting: string;
    readonly language: string;
  };
  readonly overview: {
    readonly projects: string;
    readonly members: string;
    readonly signingKeys: string;
    readonly reach: string;
    readonly recentDecisions: string;
    readonly allDecisions: string;
    readonly state: string;
    readonly healthy: string;
    readonly notAnswering: string;
    readonly version: string;
    readonly checked: string;
    readonly storage: string;
    readonly storageRoot: string;
    readonly signInAt: string;
    readonly data: string;
    readonly authority: string;
    readonly loopback: string;
  };
  readonly projects: {
    readonly newProject: string;
    readonly name: string;
    readonly create: string;
    readonly cancel: string;
    readonly empty: string;
    readonly revisionCount: (revisions: string) => string;
    readonly owner: string;
    readonly created: string;
    readonly branch: string;
    readonly revisions: string;
    readonly repository: string;
    readonly lastRevision: string;
    readonly message: string;
    readonly projectFile: string;
    readonly title: string;
    readonly stage: string;
    readonly scenes: string;
    readonly assets: string;
  };
  readonly members: {
    readonly account: string;
    readonly role: string;
    readonly projects: string;
    readonly added: string;
    readonly state: string;
    readonly none: string;
    readonly active: string;
    readonly disabled: string;
    readonly serviceAccount: string;
    readonly enable: string;
    readonly disable: string;
    readonly revokeTokens: string;
    /** Making one, which is a form of five fields and a button. */
    readonly newAccount: string;
    readonly username: string;
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
    readonly operator: string;
    readonly create: string;
    readonly cancel: string;
    /** Handing one over: the button, and what is said around the token. */
    readonly issueToken: string;
    readonly tokenFor: (fields: { readonly username: string }) => string;
    /**
     * Said beside a token that has just been shown.
     *
     * It is the whole of what a person has to know about it: this server keeps
     * no copy, so a token nobody copied is a token to ask for again.
     */
    readonly tokenShownOnce: string;
    readonly done: string;
  };
  readonly decisions: {
    readonly when: string;
    readonly account: string;
    readonly resource: string;
    readonly answer: string;
    readonly detail: string;
    readonly allowed: string;
    readonly refused: string;
    readonly empty: string;
  };
  readonly settings: {
    readonly change: string;
    readonly save: string;
    readonly cancel: string;
    readonly rotateKey: string;
    /**
     * The groups and rows the server sends, by the English text it sends.
     *
     * A row is found by its label on the way back — that is how a value ends up
     * in the right setting — so the label in the view stays what it always was
     * and this is a second name for drawing it. A label with no entry here is
     * drawn as it arrived, which is what a row added later does before anybody
     * has translated it.
     */
    readonly groupNames: Readonly<Record<string, string>>;
    readonly rowNames: Readonly<Record<string, string>>;
    readonly repositoryCaution: string;
  };
}

/** What an action answers with, once it has happened. */
export interface ActionMessages {
  readonly keyRotated: (fields: { readonly kid: string; readonly published: number }) => string;
  readonly userDisabled: (fields: { readonly username: string }) => string;
  readonly userEnabled: (fields: { readonly username: string }) => string;
  readonly tokensRevoked: (fields: {
    readonly username: string;
    readonly lifetime: string;
  }) => string;
  readonly settingReadOnly: string;
  readonly settingChanged: (fields: {
    readonly label: string;
    readonly value: string;
  }) => string;
  readonly accountCreated: (fields: {
    readonly username: string;
    readonly group: string;
  }) => string;
  readonly tokenIssued: (fields: {
    readonly username: string;
    readonly lifetime: string;
  }) => string;
  readonly projectCreated: (fields: {
    readonly project: string;
    readonly owner: string;
  }) => string;
  readonly loreserverNotOurs: string;
}

/** Why something was refused, said to whoever asked for it. */
export interface RefusalMessages {
  readonly notSignedIn: string;
  readonly sessionEnded: string;
  readonly signInRefused: string;
  /** Said in place of a check, when too many from this place have been refused. */
  readonly tooManySignIns: (fields: { readonly seconds: number }) => string;
  readonly notAnOperator: (fields: { readonly group: string }) => string;
  readonly needUsernameAndPassword: string;
  readonly fromSomewhereElse: string;
  readonly needsJson: string;
  readonly notJson: string;
  readonly tooLong: string;
  readonly notAnAction: string;
  readonly notSomethingWeDo: string;
  readonly projectNeedsNameAndOwner: string;
  readonly needsAccount: string;
  readonly accountNeedsUsernameAndPassword: string;
  readonly needsAccountAndDisabled: string;
  readonly settingNeedsRowAndValue: string;
  readonly nothingAtThatAddress: string;
  readonly methodNotAllowed: string;
  readonly wentWrong: string;
  /** The two the router answers with before any of this is reached. */
  readonly interfaceIsOff: string;
  readonly noInterfaceBuilt: string;
  /** What the page says when the server is not answering at all. */
  readonly serverSilent: string;
  readonly serverAnswered: (fields: { readonly status: number }) => string;
}

/** What went wrong, for the failures an interface can actually cause. */
export interface ErrorMessages {
  readonly unknownUser: (fields: { readonly username: string }) => string;
  readonly unknownProject: (fields: { readonly project: string }) => string;
  readonly invalidProjectName: (fields: { readonly project: string }) => string;
  readonly projectNameTaken: (fields: { readonly project: string }) => string;
  readonly accountDisabled: (fields: { readonly username: string }) => string;
  readonly noSigningKey: (fields: { readonly directory: string }) => string;
  readonly invalidSetting: (fields: {
    readonly label: string;
    readonly value: string;
    readonly minimum: string;
    readonly maximum: string;
  }) => string;
  readonly invalidServerName: (fields: {
    readonly value: string;
    readonly maximum: string;
  }) => string;
  readonly notADuration: (fields: { readonly value: string }) => string;
  readonly durationTooSmall: string;
  readonly loreserverRefused: (fields: { readonly detail: string }) => string;
  readonly loreserverSilent: string;
}

/** One language, whole. */
export interface Messages {
  readonly locale: Locale;
  /** What this language calls itself, which is what a switcher has to show. */
  readonly name: string;
  readonly format: FormatMessages;
  readonly page: PageMessages;
  readonly action: ActionMessages;
  readonly refusal: RefusalMessages;
  readonly error: ErrorMessages;
}
