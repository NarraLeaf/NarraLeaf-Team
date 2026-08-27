/**
 * What this server is, worked out when somebody asks for it.
 *
 * There used to be a gather that produced one whole account of a server — what
 * it is running, who has an account on it, what it holds — and it ran on a
 * 200 ms timer whether or not anybody was watching. The hosts it fed are gone,
 * and the shape of the thing it produced went with them; what is left is this,
 * which is the same collection logic under two rules that the timer broke:
 *
 *  - **Nobody asking costs nothing.** Two of the parts are genuinely expensive.
 *    The health check is a request to another server, and measuring the store
 *    walks and stats every file underneath it, which is bounded at fifty
 *    thousand of them. Neither is worth doing on the chance that somebody might
 *    later want the answer.
 *  - **Asking twice costs once.** An answer is kept for {@link STATUS_FRESHNESS_MS}
 *    and handed to whoever asks inside it, and callers who arrive while a gather
 *    is running wait on that gather rather than starting one each. A management
 *    panel with four sections open, or four operators with one open apiece, is
 *    one health check and one walk of the store.
 *
 * What that costs is that the answer is not live, and it says so: it carries the
 * moment it was worked out and how long an answer is kept, so a panel showing
 * "as of" is telling the truth rather than showing the clock.
 *
 * The cache is held against the service rather than in a variable of this
 * module, so that two servers in one process — which is every test run — do not
 * read each other's answers, and so that nothing here keeps a database alive by
 * remembering something about it.
 */
import { countDecisions } from "../identity/audit.js";
import { audienceHosts, authUrl, dataRemoteUrl } from "../identity/config.js";
import { countUsers } from "../identity/users.js";
import { checkHealth } from "../loreserver/health.js";
import { LORESERVER_VERSION } from "../loreserver/pin.js";
import { listProjects } from "../projects/registry.js";
import { VERSION } from "../version.js";
import { directoryBytes, storageRootOf } from "../view.js";
import type { TeamAdminStatus } from "./protocol.js";
import type { TeamService } from "./service.js";

/**
 * How long an answer is served before it is worked out again.
 *
 * Ten seconds, which is a compromise between the two things this is measured
 * against. A person watching a management panel wants "is the server beside
 * this one answering" to be roughly true, and ten seconds is inside the time it
 * takes to notice something is wrong and look. Against that, the walk of the
 * store is the most expensive read this server makes on anybody's behalf, and a
 * panel that polls — which is what a panel with no topic to listen to does — must
 * not be able to make this server do it once a second by asking once a second.
 *
 * It is sent to the caller rather than kept private, so that a panel deciding
 * how often to ask reads this number instead of guessing at one.
 */
export const STATUS_FRESHNESS_MS = 10_000;

/** The word for a value this server has but cannot show. */
const UNKNOWN_FINGERPRINT = "unknown";

interface CachedStatus {
  /** The last answer, absent until one has been worked out. */
  answer?: TeamAdminStatus;
  /** The gather in progress, which every caller arriving during it waits on. */
  inFlight?: Promise<TeamAdminStatus>;
}

const cached = new WeakMap<TeamService, CachedStatus>();

/**
 * What this server is, from cache where the cache is still fresh.
 *
 * The gather in progress is remembered before it is awaited, so that a caller
 * arriving a microsecond later finds the promise rather than an empty cache —
 * which is the whole of "concurrent callers share one gather". A gather that
 * fails leaves nothing fresh behind: the next caller starts one rather than
 * being handed a refusal that was ten seconds old.
 *
 * `now` is named only by a test that needs a fixed clock. Nothing that answers a
 * call passes it, because what "fresh" means is a length of time and not a
 * caller's opinion about one.
 */
export function serverStatus(
  options: TeamService,
  now: number = Date.now(),
): Promise<TeamAdminStatus> {
  const entry = cached.get(options) ?? {};
  if (entry.answer !== undefined && now - entry.answer.gatheredAt < STATUS_FRESHNESS_MS) {
    return Promise.resolve(entry.answer);
  }
  if (entry.inFlight !== undefined) {
    return entry.inFlight;
  }
  const gathering = gather(options)
    .then((answer) => {
      cached.set(options, { answer });
      return answer;
    })
    .catch((error: unknown) => {
      cached.set(options, entry.answer === undefined ? {} : { answer: entry.answer });
      throw error;
    });
  cached.set(options, { ...entry, inFlight: gathering });
  return gathering;
}

async function gather(options: TeamService): Promise<TeamAdminStatus> {
  const { database, config } = options;
  const storageRoot = storageRootOf(options.root);

  // Both before the moment is taken, so that `gatheredAt` is when the answer
  // was finished rather than when it was started - a walk of a large store can
  // take a noticeable fraction of a second, and a panel saying "as of" should
  // not be a fraction of a second optimistic about the health check beside it.
  const healthy = await checkHealth(options.healthPort);
  const storageBytes = await directoryBytes(storageRoot);

  // Re-read first, so that a `nlteam key rotate` in another terminal shows up
  // without this process being restarted. The store throttles its own re-reads,
  // so asking on every call costs a scan every few seconds at worst.
  await options.keys.reload();

  return {
    gatheredAt: Date.now(),
    freshnessMs: STATUS_FRESHNESS_MS,
    version: VERSION,
    root: options.root,
    loreserver: {
      version: LORESERVER_VERSION,
      healthy,
      storageRoot,
      // Absent rather than nought where it could not be added up. See
      // directoryBytes: a partial total looks exactly like a real one.
      ...(storageBytes === undefined ? {} : { storageBytes }),
    },
    reach: {
      signIn: authUrl(config),
      data: dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort),
      fingerprint: options.fingerprint ?? UNKNOWN_FINGERPRINT,
      loopback: [
        { port: options.healthPort, what: "health" },
        { port: config.teamPort, what: "jwks" },
        { port: config.authPort, what: "authz" },
      ],
    },
    // Counts rather than the collections themselves: each of these has a method
    // that pages it, and a status that carried the rows too would be the one
    // answer on this server whose size grew with the server.
    accounts: countUsers(database),
    projects: listProjects(database).length,
    decisions: countDecisions(database),
    signingKeys: options.keys.published.length,
  };
}
