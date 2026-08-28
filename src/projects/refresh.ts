/**
 * Reading every project's repository, without anything waiting for it.
 *
 * The database answers instantly and a repository does not: a clone is network
 * work, and the first read of a project Team has never seen is the slowest one
 * it will ever do. So the view is gathered from the database and drawn, and
 * this fills the repository parts in afterwards, telling whoever is drawing
 * that there is something new to draw.
 *
 * Until a project has been read its history and its file are simply absent,
 * which is already what the interface renders as unknown. That is the whole of
 * what a slow or unreachable loreserver costs: freshness. Nothing waits, and
 * nothing on screen turns into an error.
 *
 * One project at a time, on purpose. Two clones at once would compete for the
 * same bandwidth to say the same thing later, and the point of this is that
 * nobody is waiting for any particular one of them.
 */
import type { DatabaseSync } from "node:sqlite";

import { forLog } from "../identity/audit.js";
import { audienceHosts, authUrl, dataRemoteUrl, type IdentityConfig } from "../identity/config.js";
import { KeyStore } from "../identity/keys.js";
import { identityLayout } from "../identity/layout.js";
import { mintToken } from "../identity/tokens.js";
import { findUserById } from "../identity/users.js";
import { listProjects, PROJECT_PERMISSIONS, resourceIdOf } from "./registry.js";
import {
  readProject,
  readRevisionPage,
  type ProjectReading,
  type RevisionPage,
} from "./read.js";

/** A failure in words, whatever it arrived as. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How long between passes over every project. */
const DEFAULT_INTERVAL_MS = 60_000;

export interface ProjectReadingsOptions {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly config: IdentityConfig;
  /**
   * Called each time a project's reading changed, naming the project.
   *
   * The id is there because what listens is a session publishing on that
   * project's own topic, and a topic needs to be named.
   */
  readonly onChange?: (projectId: string) => void;
  /**
   * Called when a project stops being readable, or starts again.
   *
   * Only on the change, never on the interval: a repository that has been
   * unreadable for a week is one sentence, not ten thousand. See
   * {@link ProjectReadings.announce}.
   *
   * Optional because only `up` has anywhere to put a line. Everything else
   * reads the same failure off the project itself.
   */
  readonly onReadability?: (line: string) => void;
  readonly intervalMs?: number;
}

/**
 * What one project's repository last said.
 *
 * The map is only ever added to and replaced in whole entries, so a reader
 * taking a view of it never sees half of a project's reading.
 */
export class ProjectReadings {
  private readonly readings = new Map<string, ProjectReading>();
  /**
   * The projects a read is inside of right now, whichever read it is.
   *
   * One checkout cannot be read twice at once. The pass below replaces a
   * checkout wholesale when it has to clone again, and on Windows a directory
   * the library is holding cannot be removed — so a page being served out of
   * one is a reason for the pass to leave it alone this time round, and a pass
   * already in a project is a reason for the page to say it has not been read.
   * Neither waits for the other: a pass takes as long as a clone takes, and
   * nothing answering a request may sit behind one.
   */
  private readonly inside = new Set<string>();
  /**
   * What was last said out loud about each project, so that nothing is said
   * twice. The empty string is "this one reads", which is worth saying once
   * after it has not.
   */
  private readonly announced = new Map<string, string>();
  private keys: KeyStore | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private wanted = false;
  private stopped = false;

  constructor(private readonly options: ProjectReadingsOptions) {}

  /** What Team last read about one project, or undefined if it has not. */
  get(projectId: string): ProjectReading | undefined {
    return this.readings.get(projectId);
  }

  /**
   * Drop what was read about one project, because it is no longer one.
   *
   * For when a project is taken off this server. The reading would otherwise
   * outlive the row it belongs to, and a repository registered again under the
   * same id — which is exactly what an author retrying a publish does — would
   * be answered for out of what was read before it went away.
   *
   * What was said out loud about it goes with it, so that a repository which
   * could not be read, was removed, and came back is reported on again rather
   * than being held to a verdict reached about the last one.
   *
   * The checkout on disk is left alone. It is a cache keyed by repository id,
   * the id is the same repository either way, and throwing a directory away is
   * work that can fail while nothing is waiting on it.
   */
  forget(projectId: string): void {
    this.readings.delete(projectId);
    this.announced.delete(projectId);
  }

  /**
   * One page of a project's revision history, read when it is asked for.
   *
   * Never on the interval: this is here rather than in {@link pass} because a
   * history is read by one person looking at one project, and putting it on a
   * loop would make every server pay for every page nobody asked for.
   *
   * Undefined for a project Team has no checkout of, and for one a pass is
   * inside of at this moment. Both mean the same thing to whoever asked — Team
   * has not got this to hand — and neither is worth holding a request open for.
   */
  async revisions(
    projectId: string,
    page: { readonly limit: number; readonly limitBytes: number; readonly before?: string },
  ): Promise<RevisionPage | undefined> {
    if (this.inside.has(projectId)) {
      return undefined;
    }
    this.inside.add(projectId);
    try {
      // Both ceilings are the caller's, for the reason the count alone was: how
      // large an answer this server composes is a question about the protocol,
      // and this reader knows about repositories.
      return await readRevisionPage({
        root: this.options.root,
        projectId,
        limit: page.limit,
        limitBytes: page.limitBytes,
        ...(page.before === undefined ? {} : { before: page.before }),
      });
    } finally {
      this.inside.delete(projectId);
    }
  }

  /** Begin reading, and keep reading on an interval until stopped. */
  start(): void {
    if (this.stopped) {
      return;
    }
    this.request();
    this.timer = setInterval(() => this.request(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    // Nothing should be kept alive by this: when the screen is gone, so is the
    // reason to read anything.
    this.timer.unref();
  }

  /**
   * Ask for a pass now.
   *
   * A pass already under way is not interrupted and a second one is not
   * started beside it; one more is run after it instead, so that pressing
   * refresh repeatedly costs one extra pass rather than one each.
   */
  request(): void {
    if (this.stopped) {
      return;
    }
    this.wanted = true;
    if (!this.running) {
      void this.drain();
    }
  }

  /** Stop reading. A pass under way is left to finish on its own. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.wanted && !this.stopped) {
        this.wanted = false;
        await this.pass();
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Say — once — that a project's repository could not be read, and why.
   *
   * The rule about *data* is unchanged and is not up for negotiation: a
   * project Team has not read has no history rather than a history of nought,
   * and nothing on any screen turns into an error. This is the other half of
   * that, which was missing: a reader that has never once worked looked
   * exactly like a reader that had not got round to it yet, and a defect that
   * emptied every project on every real deployment survived because of it.
   *
   * Said when the outcome changes and at no other time. A server whose
   * loreserver is down says one sentence, not one a minute for a fortnight,
   * and says one more when it comes back.
   *
   * What counts as read is the count, not the file: a repository nobody has
   * pushed to answers with nought revisions and no file, and that is a
   * complete, correct reading of an empty project rather than a failure.
   *
   * A project nothing has been said about yet is taken to be readable, so a
   * server where everything works says nothing at all. Announcing the first
   * success would put a line about every project on the screen of every
   * healthy server, and a notice printed when nothing is wrong is the fastest
   * way to teach somebody not to read them.
   */
  private announce(project: { id: string; name: string }, reading: ProjectReading): void {
    const report = this.options.onReadability;
    if (report === undefined) {
      return;
    }
    const because = reading.history.revisions === undefined ? (reading.file.reason ?? "") : "";
    if ((this.announced.get(project.id) ?? "") === because) {
      return;
    }
    this.announced.set(project.id, because);
    report(
      because === ""
        ? `read ${project.name}'s repository again`
        : `cannot read ${project.name}'s repository: ${because}`,
    );
  }

  private async pass(): Promise<void> {
    const { root, database, config } = this.options;
    const remote = dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort);

    // Nothing here settles the environment the version control library reads.
    // Both variables it takes are decided in src/lore/environment.ts, once,
    // before the command that owns this reader starts it — see that file for
    // why deciding them on the first pass was a race this could not win and a
    // failure nobody could see.

    // Once per pass rather than once per project, and re-read each pass so
    // that a key rotated in another terminal is picked up without this being
    // restarted. A Team server that has not been brought up has no keys directory at
    // all, and that is a reason to read without a token rather than to stop.
    this.keys = await KeyStore.open(identityLayout(root).keysDir).catch(() => undefined);

    for (const project of listProjects(database)) {
      if (this.stopped) {
        return;
      }
      if (this.inside.has(project.id)) {
        // Somebody is reading a page out of this checkout. Left as it was and
        // picked up next time round, which costs this project one minute of
        // freshness and costs the request nothing.
        continue;
      }
      this.inside.add(project.id);
      try {
        const token = this.mint(project.id, project.createdBy);
        const reading = await readProject({
          root,
          projectId: project.id,
          projectName: project.name,
          remote,
          // The https endpoint, and there is no alternative: Lore's client
          // registers handlers for `https` and `ucs-auth` only, and answers a
          // plaintext one with "no authentication implementation registered
          // for scheme 'http'". Reaching it is what {@link trustOwnAuthority}
          // is for.
          ...(token === undefined ? {} : { token, authUrl: authUrl(config) }),
        });
        this.readings.set(project.id, reading);
        this.announce(project, reading);
      } catch (error) {
        // readProject answers rather than raising, so anything reaching here is
        // Team's own doing — minting a token, or something worse. It is put
        // where every other thing Team could not read goes, which is the screen,
        // rather than into a log nobody has open. The pass carries on: one
        // project that cannot be read must not cost the others theirs.
        const reading: ProjectReading = {
          history: {},
          file: {
            readable: false,
            // Escaped for the reason ./content.ts gives: this sentence is
            // printed to whoever is watching, and what an error carries is not
            // always this server's own words.
            reason: `Team could not read this project: ${forLog(describe(error))}`,
          },
          cloned: false,
        };
        this.readings.set(project.id, reading);
        this.announce(project, reading);
      } finally {
        this.inside.delete(project.id);
      }
      this.options.onChange?.(project.id);
    }
  }

  /**
   * A token for reading one project, or undefined if none can be made.
   *
   * Minted for the account that owns the project and named for that project
   * alone, which is the same shape a Studio installation presents. Undefined
   * where the owner is gone or disabled — a loreserver that demands nobody's
   * identity accepts the read anyway, and one that does refuses it with a
   * sentence that says so, which is better than Team reading as somebody who
   * has been shut out.
   */
  private mint(projectId: string, ownerId: string): string | undefined {
    const keys = this.keys;
    if (keys === undefined) {
      return undefined;
    }
    try {
      const owner = findUserById(this.options.database, ownerId);
      if (owner === undefined) {
        return undefined;
      }
      return mintToken(owner, keys.signingKey, this.options.config, {
        // The short lifetime, because this one is presented on the data
        // connection and Team is not asked about it again.
        purpose: "repository",
        resources: [{ resource_id: resourceIdOf(projectId), permission: [...PROJECT_PERMISSIONS] }],
      }).token;
    } catch {
      return undefined;
    }
  }
}
