/**
 * One view of a server, gathered when it changes and handed to whoever is
 * drawing it.
 *
 * Both interfaces need the same three things and neither should own them: the
 * repositories read beside the screen rather than in front of it, a gather that
 * happens once however many readings landed at the same moment, and a way to be
 * told when there is a new one. A terminal and a browser subscribe to the same
 * publisher and see the same view, which is what stops them being two accounts
 * of the same server.
 *
 * Nothing here waits on the network. What a project's revision history says is
 * inside a repository, and reading one is a network call — see
 * src/projects/refresh.ts — so a reading replaces the word unknown when it
 * arrives and holds nothing up before it does.
 */
import { identityLayout } from "./identity/layout.js";
import { ProjectReadings } from "./projects/refresh.js";
import type { TeamView } from "./teamview.js";
import { gatherTeamView, type ViewContext } from "./view.js";

import type { IdentityConfig } from "./identity/config.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * How long a publish waits for more readings before it happens.
 *
 * Short enough that a project appearing feels immediate, long enough that a
 * pass over several of them costs one gather rather than one each. A gather
 * measures the whole storage root, so on a server with forty projects this is
 * the difference between forty walks of the store and a handful.
 */
const PUBLISH_DELAY_MS = 200;

export interface PublisherOptions {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly config: IdentityConfig;
  readonly healthPort: number;
  /** The fingerprint of this server's authority, absent until one exists. */
  readonly fingerprint: string | undefined;
  /**
   * Where to say that a repository stopped being readable, or started again.
   *
   * Handed on to the reader unchanged. Absent for an interface with nowhere to
   * put a line — see src/projects/refresh.ts on when it is called.
   */
  readonly onReadability?: (line: string) => void;
  /**
   * Called with a project's id each time this server has read its repository.
   *
   * Where a session announces it. Separate from the redraw the views do because
   * the two want different things: a screen redraws whatever it is holding, and
   * a topic needs to be named.
   */
  readonly onProjectRead?: (projectId: string) => void;
}

/** The views of one server, as they change. */
export class ViewPublisher {
  readonly #listeners = new Set<(view: TeamView) => void>();
  readonly #readings: ProjectReadings;
  readonly #context: ViewContext;
  #scheduled: NodeJS.Timeout | undefined;

  constructor(options: PublisherOptions) {
    const root = identityLayout(options.root).root;
    this.#readings = new ProjectReadings({
      root,
      database: options.database,
      config: options.config,
      onChange: (projectId) => {
        this.#schedule();
        options.onProjectRead?.(projectId);
      },
      ...(options.onReadability === undefined ? {} : { onReadability: options.onReadability }),
    });
    this.#context = {
      root,
      database: options.database,
      config: options.config,
      healthPort: options.healthPort,
      fingerprint: options.fingerprint,
      readings: this.#readings,
    };
  }

  /** What everything here is gathered from, for whoever has to act on it. */
  get context(): ViewContext {
    return this.#context;
  }

  /**
   * What the repositories last said, for whoever answers a request out of it.
   *
   * The same reader the views are gathered from, handed out rather than made a
   * second time: two of them would clone every project twice and disagree
   * about which of the two answers was the fresher.
   */
  get readings(): ProjectReadings {
    return this.#readings;
  }

  /** Start reading the repositories. */
  start(): void {
    this.#readings.start();
  }

  /** Stop, and let go of anything that would keep the process alive. */
  stop(): void {
    this.#readings.stop();
    if (this.#scheduled !== undefined) {
      clearTimeout(this.#scheduled);
      this.#scheduled = undefined;
    }
    this.#listeners.clear();
  }

  /** Gather one now. */
  gather(): Promise<TeamView> {
    return gatherTeamView(this.#context);
  }

  /**
   * Ask for the repositories to be read again.
   *
   * Deliberately not awaited by anything: somebody asking for a refresh means
   * the repositories too, and waiting for them is exactly what a refresh must
   * not do.
   */
  request(): void {
    this.#readings.request();
  }

  /** Be told about every view from now on. Returns the way to stop being told. */
  subscribe(listen: (view: TeamView) => void): () => void {
    this.#listeners.add(listen);
    return () => {
      this.#listeners.delete(listen);
    };
  }

  #schedule(): void {
    if (this.#scheduled !== undefined) {
      return;
    }
    this.#scheduled = setTimeout(() => {
      this.#scheduled = undefined;
      void this.gather()
        .then((view) => {
          for (const listener of this.#listeners) {
            listener(view);
          }
        })
        .catch(() => {
          // Nothing is written anywhere from here. The terminal interface owns
          // the alternate screen, and a line on stderr in the middle of it is
          // rubbish across whatever was drawn; a browser is holding a view it
          // can go on showing. A gather that failed is a screen that stays as
          // it was, and the next reading tries again.
        });
    }, PUBLISH_DELAY_MS);
    // Nothing should be held open by a publish that has not happened yet.
    this.#scheduled.unref();
  }
}
