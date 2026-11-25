/**
 * Telling people about new versions of Team.
 *
 * Two things, for two audiences:
 *
 *  - {@link ReleaseNotice}: a newer Team has been released. Only an operator
 *    can act on that, so only an operator is told, on the home page, until
 *    they skip that version. The server asks GitHub (src/updates.ts); the page
 *    only reads what it learned.
 *  - {@link UpgradedNotice}: the server this page talks to was upgraded while
 *    the page stayed open. The page is the old console then, so everybody is
 *    offered a reload. Told by the socket: every connection's hello names the
 *    server's version, and a restart is a reconnect.
 *
 * Neither installs anything. Upgrading is for an operator to choose
 * (docs/operations.md, "Upgrading").
 */
import { useEffect, useState } from "react";

import type { ConsoleAccount } from "./api";
import { t } from "./i18n";
import type { ConnectionState } from "./socket";
import { Flash } from "./ui";

declare const __NLTEAM_VERSION__: string;

/** The version this page was built as, the same field the server's version comes from. */
export const CONSOLE_VERSION: string = __NLTEAM_VERSION__;

const UPGRADE_DOCS_URL = "https://github.com/NarraLeaf/NarraLeaf-Team/blob/main/docs/operations.md#upgrading";
const SKIPPED_KEY = "nlteam.releaseSkipped";

interface UpdateStatus {
  readonly current: string;
  readonly enabled: boolean;
  readonly latest?: string;
  readonly newer: boolean;
  readonly releaseUrl?: string;
}

function skipped(): string | null {
  try {
    return localStorage.getItem(SKIPPED_KEY);
  } catch {
    return null;
  }
}

/** A newer release, for an operator. Nothing for anybody else, nor while there is none. */
export function ReleaseNotice({ account }: { account: ConsoleAccount }) {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined);
  const [skip, setSkip] = useState<string | null>(() => skipped());
  useEffect(() => {
    if (!account.operator) return undefined;
    let alive = true;
    fetch("/api/console/v1/update", { credentials: "same-origin" })
      .then((response) => (response.ok ? (response.json() as Promise<UpdateStatus>) : undefined))
      .then((found) => {
        if (alive) setStatus(found);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [account.operator]);
  if (status === undefined || !status.newer || status.latest === undefined || skip === status.latest) return null;
  const latest = status.latest;
  const skipThis = () => {
    try {
      localStorage.setItem(SKIPPED_KEY, latest);
    } catch {
      /* a private window: hidden for this visit only */
    }
    setSkip(latest);
  };
  return (
    <div className="beta-notice">
      <Flash
        tone="info"
        action={
          <button className="btn btn-sm" type="button" onClick={skipThis}>
            {t("releaseSkip")}
          </button>
        }
      >
        {t("releaseNotice", { latest, current: status.current })}
        {" · "}
        {status.releaseUrl === undefined ? null : (
          <>
            <a href={status.releaseUrl} target="_blank" rel="noreferrer">
              {t("releaseNotes")}
            </a>
            {" · "}
          </>
        )}
        <a href={UPGRADE_DOCS_URL} target="_blank" rel="noreferrer">
          {t("releaseHowTo")}
        </a>
      </Flash>
    </div>
  );
}

/** The server was upgraded under this open page: offer a reload. */
export function UpgradedNotice({ state }: { state: ConnectionState }) {
  if (state.kind !== "open") return null;
  const version = state.hello.server.version;
  if (version === CONSOLE_VERSION) return null;
  return (
    <div className="upgraded-notice">
      <Flash
        tone="info"
        action={
          <button className="btn btn-sm btn-primary" type="button" onClick={() => window.location.reload()}>
            {t("upgradedReload")}
          </button>
        }
      >
        {t("upgradedNotice", { version })}
      </Flash>
    </div>
  );
}
