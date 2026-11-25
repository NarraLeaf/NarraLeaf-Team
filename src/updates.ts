/**
 * Whether a newer Team has been released, for the console to tell an operator.
 *
 * Asked of GitHub, where releases are tagged `vX.Y.Z`: the tags rather than
 * the Releases page, because a release is tagged (and its image published)
 * whether or not anybody wrote it a Releases entry. Asked once at start and
 * twice a day after, never on a page load, so the console never waits on
 * GitHub and a server with no route out makes one failed request per check.
 *
 * Only told, never acted on. A container cannot replace the image it runs in,
 * and a deployment pins its version on purpose (docs/operations.md): what an
 * upgrade means is for an operator to choose. `--no-update-check` or
 * `NLTEAM_UPDATE_CHECK=false` turns the asking off, for a server that must not
 * reach the internet.
 */
import { VERSION } from "./version.js";

/** Where Team is released. */
export const RELEASE_REPOSITORY = "NarraLeaf/NarraLeaf-Team";
const TAGS_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/tags?per_page=100`;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 15_000;

type Version = readonly [number, number, number];

/** `1.2.3` or `v1.2.3`, as numbers. Undefined for anything else, a pre-release included. */
export function parseVersion(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`, positive when newer, zero when the same. */
export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The newest release among some tag names, as `X.Y.Z`. Undefined when none is a release. */
export function newestRelease(tags: readonly string[]): string | undefined {
  let newest: Version | undefined;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (version !== undefined && (newest === undefined || compareVersions(version, newest) > 0)) newest = version;
  }
  return newest?.join(".");
}

/** What the console is told. */
export interface UpdateStatus {
  /** This server's version. */
  readonly current: string;
  /** False when an operator turned checking off. */
  readonly enabled: boolean;
  /** The newest release seen, once a check has succeeded. */
  readonly latest?: string;
  /** True when {@link latest} is newer than {@link current}. */
  readonly newer: boolean;
  /** Where to read about {@link latest}. */
  readonly releaseUrl?: string;
  /** When the last check that succeeded finished, in milliseconds. */
  readonly checkedAt?: number;
  /** Why the most recent check failed, when it did; what was learned before still stands. */
  readonly problem?: string;
}

export interface UpdateCheckOptions {
  readonly enabled: boolean;
  readonly current?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly everyMs?: number;
}

export class UpdateCheck {
  private readonly current: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private latest: string | undefined;
  private checkedAt: number | undefined;
  private problem: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly options: UpdateCheckOptions) {
    this.current = options.current ?? VERSION;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Check now and then on a timer that never keeps the process alive. Does nothing when off. */
  public start(): void {
    if (!this.options.enabled || this.timer !== undefined) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.options.everyMs ?? CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Ask GitHub once. Never throws: a failure is kept as {@link UpdateStatus.problem}. */
  public async check(): Promise<void> {
    if (!this.options.enabled) return;
    try {
      const response = await this.fetchImpl(TAGS_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": `nlteam/${this.current}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const body = (await response.json()) as unknown;
      const names = Array.isArray(body)
        ? body.flatMap((tag) => (tag !== null && typeof tag === "object" && typeof (tag as { name?: unknown }).name === "string" ? [(tag as { name: string }).name] : []))
        : [];
      const newest = newestRelease(names);
      if (newest === undefined) throw new Error("GitHub listed no release");
      this.latest = newest;
      this.checkedAt = this.now();
      this.problem = undefined;
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error);
    }
  }

  public status(): UpdateStatus {
    const current = parseVersion(this.current);
    const latest = this.latest === undefined ? undefined : parseVersion(this.latest);
    return {
      current: this.current,
      enabled: this.options.enabled,
      newer: current !== undefined && latest !== undefined && compareVersions(latest, current) > 0,
      ...(this.latest === undefined ? {} : { latest: this.latest, releaseUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${this.latest}` }),
      ...(this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt }),
      ...(this.problem === undefined ? {} : { problem: this.problem }),
    };
  }
}
