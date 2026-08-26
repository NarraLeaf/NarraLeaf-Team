/**
 * The service every answer is composed from.
 *
 * One object, made once when a server starts and handed to everything that
 * answers: the identity database, the signing keys, the configuration this
 * deployment was brought up with, and whatever the project reader has landed so
 * far. A method on a session and the sign-in route are given the same one, which
 * is what keeps a token minted at either door lasting the same time and a project
 * read over either reading the same.
 *
 * Nothing here is per-request. Who is calling arrives separately, freshly
 * identified for each call - see src/team/methods.ts.
 */
import type { DatabaseSync } from "node:sqlite";

import type { IdentityConfig } from "../identity/config.js";
import type { KeyStore } from "../identity/keys.js";
import { storedTokenLifetimes, type TokenLifetimes } from "../identity/settings.js";
import type { SignInLimiter } from "../identity/signin.js";
import type { RevisionPage } from "../projects/read.js";
import type { ProjectFileView, RevisionView } from "../teamview.js";
import type { TeamCapability } from "./protocol.js";

/**
 * What Team has read out of the repositories, and a way to read one page more.
 *
 * Deliberately optional, and deliberately only a lookup. Answering a request
 * must not start a repository read, wait for one, or be able to: a clone is the
 * slowest thing this server does, and a list of projects that stopped on a
 * loreserver which was not answering would be a list nobody could open Studio
 * without. Whatever has landed is served; the rest is absent.
 */
export interface RepositoryReadings {
  /** What Team last read about one project, or undefined if it has not. */
  get(projectId: string): { readonly history: RevisionView; readonly file: ProjectFileView } | undefined;
  /**
   * One page of a project's revisions, read on demand.
   *
   * Optional because it is what decides whether this build says it serves a
   * history at all — see {@link serviceCapabilities}. Undefined from the call
   * means Team has no checkout of that project to read yet.
   */
  readonly revisions?: (
    projectId: string,
    page: { readonly limit: number; readonly before?: string },
  ) => Promise<RevisionPage | undefined>;
  /**
   * Drop what was read about one project, because it is no longer one.
   *
   * Called when a project is taken off this server, so that the reading does
   * not outlive the row. Optional for the same reason {@link revisions} is: a
   * build serving no reader has nothing to drop, and a stand-in for one in a
   * test need not grow a method to be handed to a server that has no reading to
   * forget anyway.
   */
  readonly forget?: (projectId: string) => void;
}

/** Everything an answer needs that is not in the request. */
export interface TeamService {
  readonly database: DatabaseSync;
  readonly keys: KeyStore;
  readonly config: IdentityConfig;
  /**
   * Token lifetimes named on the command line this server was started with.
   *
   * Absent is the ordinary case, and then the stored settings decide. What an
   * operator typed has to outrank them, or `up --token-lifetime` would stop
   * doing anything the moment somebody stored the setting it names — the same
   * rule the authorization service is written to, so that a token minted here
   * and one minted there last the same time.
   */
  readonly namedLifetimes?: Partial<TokenLifetimes>;
  /** The port loreserver serves gRPC on, for creating a repository. */
  readonly dataPort: number;
  /**
   * The fingerprint of this server's authority, absent until one exists.
   *
   * Written into a token handed out by the sign-in route, because that token
   * leaves this machine — the same reason `nlteam token mint` writes it. A
   * server with no certificates yet still signs in; its tokens simply carry no
   * fingerprint, and Studio falls back to asking a person for one.
   */
  readonly fingerprint?: string;
  /**
   * How often a password may be guessed at here.
   *
   * Absent means the one every door of this server shares, which is what a
   * running server wants: the rate somebody may guess at a password should not
   * depend on which door they knock on. A caller passes its own when it wants
   * one that no other caller has already spent.
   */
  readonly signIns?: SignInLimiter;
  /** What the repositories last said. Absent on a server that reads none. */
  readonly readings?: RepositoryReadings;
  /** Somewhere to say what happened, in the same place `up` says everything else. */
  readonly log?: (line: string) => void;
}

/**
 * The capabilities that depend on what this build was handed.
 *
 * The other half of the vocabulary is derived from the method table, which says
 * what a session can be asked for — see src/team/methods.ts. These two are the
 * ones that table cannot say, because neither of them turns on whether a method
 * is registered:
 *
 * `password-sign-in` names the sign-in route, which is answered before a session
 * exists and so has no method to be derived from. It is unconditional: the route
 * needs nothing beyond the database and the keys, both of which every caller here
 * already has.
 *
 * `project-history` is about the reader rather than the method. `projects.history`
 * is always registered, but a build with no reader has no revisions to page and
 * answers an empty one — which a client cannot tell from a project nobody has ever
 * committed to. So the capability is present only where there is a reader that can
 * page a history, and a client that wants to offer a person a list of versions
 * checks it rather than inferring one from an empty page.
 *
 * Worked out from what this build was given rather than written down, so that the
 * discovery document cannot come to say something this server does not do.
 */
export function serviceCapabilities(options: TeamService): TeamCapability[] {
  const capabilities: TeamCapability[] = ["password-sign-in"];
  if (options.readings?.revisions !== undefined) {
    capabilities.push("project-history");
  }
  return capabilities;
}

/**
 * The settings to mint a token with, as they stand now.
 *
 * The base is what this server was brought up as. The stored lifetimes are read
 * on every mint, so shortening one reaches a running server without a restart;
 * what an operator named on the command line outranks a stored lifetime, or
 * `up --token-lifetime` would stop doing anything the moment somebody stored the
 * setting it names. This is the same order the authorization service mints by,
 * so a token handed out here and one handed out there last the same time.
 */
export function mintingConfig(options: TeamService): IdentityConfig {
  return {
    ...options.config,
    ...storedTokenLifetimes(options.database),
    ...options.namedLifetimes,
  };
}
