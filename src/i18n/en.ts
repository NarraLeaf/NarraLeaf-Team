/**
 * English, and the wording every other language is a translation of.
 *
 * These are the sentences Team already said. They are not rewritten here to fit
 * a catalogue: `nlteam user revoke-tokens` prints the same two facts in the same
 * order, and a sentence that drifted from the command's would be a second
 * account of what Team does. When one of these has to change, it changes with
 * the command it belongs to.
 */
import type { Messages } from "./messages.js";

export const en: Messages = {
  locale: "en",
  name: "English",

  format: {
    unknown: "unknown",
    never: "never",
    justNow: "just now",
    secondsAgo: (seconds) => `${seconds}s ago`,
    minutesAgo: (minutes) => `${minutes}m ago`,
    hoursAgo: (hours) => `${hours}h ago`,
    yesterday: "yesterday",
    daysAgo: (days) => `${days}d ago`,
    duration: (amount, unit) => `${amount} ${unit}${amount === 1 ? "" : "s"}`,
    durationWords: [
      ["days", "d"],
      ["day", "d"],
      ["hours", "h"],
      ["hour", "h"],
      ["minutes", "m"],
      ["minute", "m"],
      ["seconds", "s"],
      ["second", "s"],
    ],
  },

  page: {
    nav: {
      overview: "Overview",
      projects: "Projects",
      members: "Members",
      decisions: "Decisions",
      settings: "Settings",
    },
    gate: {
      username: "Username",
      password: "Password",
      signIn: "Sign in",
    },
    shell: {
      signOut: "Sign out",
      dismiss: "Dismiss",
      reconnecting: "reconnecting",
      language: "Language",
    },
    overview: {
      projects: "projects",
      members: "members",
      signingKeys: "signing keys",
      reach: "Reach",
      recentDecisions: "Recent decisions",
      allDecisions: "All decisions",
      state: "state",
      healthy: "healthy",
      notAnswering: "not answering",
      version: "version",
      checked: "checked",
      storage: "storage",
      storageRoot: "storage root",
      signInAt: "sign in at",
      data: "data",
      authority: "authority",
      loopback: "loopback",
    },
    projects: {
      newProject: "New project",
      name: "Project name",
      create: "Create",
      cancel: "Cancel",
      empty: "this server holds no projects",
      revisionCount: (revisions) => `${revisions} revisions`,
      owner: "owner",
      created: "created",
      branch: "branch",
      revisions: "revisions",
      repository: "repository",
      lastRevision: "last revision",
      message: "message",
      projectFile: "project file",
      title: "title",
      stage: "stage",
      scenes: "scenes",
      assets: "assets",
    },
    members: {
      account: "Account",
      role: "Role",
      projects: "Projects",
      added: "Added",
      state: "State",
      none: "none",
      active: "active",
      disabled: "disabled",
      serviceAccount: "service account",
      enable: "Enable",
      disable: "Disable",
      revokeTokens: "Revoke tokens",
      newAccount: "New account",
      username: "Username",
      displayName: "Display name",
      email: "Email",
      password: "Password",
      operator: "Operator",
      create: "Create",
      cancel: "Cancel",
      issueToken: "Issue token",
      tokenFor: ({ username }) => `Token for ${username}`,
      tokenShownOnce: "Shown once. This server keeps no copy of it.",
      done: "Done",
    },
    decisions: {
      when: "When",
      account: "Account",
      resource: "Resource",
      answer: "Answer",
      detail: "Detail",
      allowed: "allowed",
      refused: "refused",
      empty: "nothing has been asked of this server yet",
    },
    settings: {
      change: "Change",
      save: "Save",
      cancel: "Cancel",
      rotateKey: "Rotate signing key",
      groupNames: {
        server: "server",
        tokens: "tokens",
        identity: "identity",
        loreserver: "loreserver",
        authority: "authority",
      },
      rowNames: {
        name: "name",
        "sign-in token": "sign-in token",
        "repository token": "repository token",
        issuer: "issuer",
        audience: "audience",
        hostnames: "hostnames",
        "pinned version": "pinned version",
        "data port": "data port",
        "storage root": "storage root",
        fingerprint: "fingerprint",
      },
      // The same sentence src/identity/settings.ts names, because the command
      // and the terminal interface say it too and three copies would drift.
      repositoryCaution:
        "loreserver accepts this one without asking Team, so revoking access cannot cut it short.",
    },
  },

  action: {
    keyRotated: ({ kid, published }) =>
      `signing with ${kid}; tokens signed by any of the ${published} published keys still verify`,
    userDisabled: ({ username }) =>
      `disabled ${username}; nothing new is issued and tokens already issued are refused from now on`,
    userEnabled: ({ username }) => `enabled ${username}`,
    tokensRevoked: ({ username, lifetime }) =>
      `revoked the tokens of ${username}; a connection already open may last until its ` +
      `repository token expires, at most ${lifetime} from now`,
    settingReadOnly: "that row is read only",
    settingChanged: ({ label, value }) =>
      `${label} is ${value}; tokens already minted keep the lifetime they were given`,
    accountCreated: ({ username, group }) =>
      `created ${username} in ${group}; issue a token for them to sign in with`,
    tokenIssued: ({ username, lifetime }) =>
      `a sign-in token for ${username}, good for ${lifetime}`,
    projectCreated: ({ project, owner }) => `created ${project}, owned by ${owner}`,
    loreserverNotOurs:
      "loreserver belongs to the nlteam up that started it; stop and start that",
  },

  refusal: {
    notSignedIn: "this browser is not signed in",
    sessionEnded: "this session has ended",
    signInRefused: "the username or password is not right",
    // How often this caller has been wrong, and nothing about the account they
    // named: the rule the sentence above is written to holds here too.
    tooManySignIns: ({ seconds }) =>
      `too many sign-ins from here have been refused; try again in ${seconds} seconds`,
    notAnOperator: ({ group }) =>
      `the web interface is for the ${group} group, which this account is not in`,
    needUsernameAndPassword: "a username and a password are needed",
    fromSomewhereElse: "that request came from somewhere else",
    needsJson: "this route takes a JSON body",
    notJson: "that request is not JSON",
    tooLong: "that request is too long",
    notAnAction: "that is not an action",
    notSomethingWeDo: "that is not something this server does",
    projectNeedsNameAndOwner: "a project needs a name and an owner",
    needsAccount: "that needs an account",
    accountNeedsUsernameAndPassword: "an account needs a username and a password",
    needsAccountAndDisabled: "that needs an account and whether it is disabled",
    settingNeedsRowAndValue: "a setting needs a row and a value",
    nothingAtThatAddress: "there is nothing at that address",
    methodNotAllowed: "method not allowed",
    wentWrong: "something went wrong answering that",
    interfaceIsOff:
      "The web interface is switched off on this server. Start it with nlteam up --web.",
    noInterfaceBuilt:
      "This build carries no web interface. Run the build script and start the server again.",
    serverSilent: "this server is not answering",
    serverAnswered: ({ status }) => `the server answered ${status}`,
  },

  error: {
    unknownUser: ({ username }) => `there is no account called ${username}.`,
    unknownProject: ({ project }) => `there is no project called ${project}.`,
    invalidProjectName: ({ project }) =>
      `"${project}" cannot be a project name. A project name is 1 to 64 characters of ` +
      "letters, digits, dot, dash and underscore, and starts with a letter or a digit.",
    projectNameTaken: ({ project }) => `there is already a project called ${project}.`,
    accountDisabled: ({ username }) =>
      `${username} is disabled, so no token can be issued for them.`,
    noSigningKey: ({ directory }) =>
      `every key in ${directory} is retired, so nothing can sign a token. ` +
      "Rotate to create a new one.",
    invalidSetting: ({ label, value, minimum, maximum }) =>
      `${label} cannot be "${value}". A token lifetime is a whole number of seconds, at ` +
      `least ${minimum} and at most ${maximum}.`,
    invalidServerName: ({ value, maximum }) =>
      `"${value}" cannot be this server's name. A name is 1 to ${maximum} characters and ` +
      "carries no control characters. It is a label a person reads, not an address.",
    notADuration: ({ value }) => `"${value}" is not a duration. Write it as 30 minutes, 48 hours or 7 days.`,
    durationTooSmall: "a lifetime must be more than zero",
    loreserverRefused: ({ detail }) => `loreserver refused it: ${detail}`,
    loreserverSilent: "loreserver is not answering, so nothing was created",
  },
};
