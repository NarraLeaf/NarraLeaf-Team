/**
 * The two pages Studio's browser sign-in lands on: approving a sign-in
 * (/console/oauth/authorize, RFC 8252) and entering a device code
 * (/console/device, RFC 8628). Both need the person signed in first; the
 * caller shows the sign-in form and comes back here.
 */
import { useEffect, useState, type FormEvent } from "react";

import type { ConsoleAccount } from "./api";
import { t } from "./i18n";
import type { TeamLook } from "./look";
import { TeamMark } from "./SignIn";

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string; description?: string };
  if (!response.ok) {
    throw new Error(body.description ?? body.error ?? response.statusText);
  }
  return body;
}

function Card({ children, look }: { children: React.ReactNode; look?: TeamLook | undefined }) {
  return (
    <main className="gate gate-plain">
      <div className="gate-side">
        <div className="gate-card">
          <div className="gate-brand">
            <TeamMark look={look} />
            <span>{look?.name ?? t("appName")}</span>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}

export function Authorize({ account, look }: { account: ConsoleAccount; look?: TeamLook | undefined }) {
  const query = window.location.search.slice(1);
  const [ask, setAsk] = useState<{ clientName: string; deviceName: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<"approved" | "denied" | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/console/v1/oauth/authorize?${query}`, { credentials: "same-origin" })
      .then((response) => json<{ clientName: string; deviceName: string }>(response))
      .then(setAsk)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [query]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const answer = await json<{ redirect: string }>(
        await fetch("/api/console/v1/oauth/authorize", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, approve }),
        }),
      );
      setDone(approve ? "approved" : "denied");
      // To Studio's loopback listener, which closes the loop.
      window.location.assign(answer.redirect);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  return (
    <Card look={look}>
      <div className="authorize">
        <div className="authorize-link" aria-hidden="true">
          <span className="authorize-app">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 19c8 0 14-6 14-14-8 0-14 6-14 14zM5 19l7-7" />
            </svg>
          </span>
          <span className="authorize-dots">
            <i />
            <i />
            <i />
          </span>
          <TeamMark look={look} size={48} />
        </div>
        <h1>{t("authorizeTitle")}</h1>
        {error !== undefined ? <p className="error">{error}</p> : null}
        {done === "approved" ? (
          <p className="authorize-done">
            <span className="authorize-tick" aria-hidden="true">
              ✓
            </span>
            {t("authorizeDone")}
          </p>
        ) : null}
        {done === "denied" ? <p className="muted">{t("authorizeDenied")}</p> : null}
        {ask !== undefined && done === undefined ? (
          <>
            <p>{t("authorizeLead", { client: ask.clientName, server: window.location.host })}</p>
            <dl className="authorize-facts">
              <dt>{t("authorizeDeviceLabel")}</dt>
              <dd>{ask.deviceName}</dd>
              <dt>{t("authorizeAccountLabel")}</dt>
              <dd>{account.displayName || account.username}</dd>
            </dl>
            <p className="muted small">{t("authorizeRevokeHint")}</p>
            <div className="actions authorize-actions">
              <button className="ghost outline" disabled={busy} onClick={() => void decide(false)}>
                {t("deny")}
              </button>
              <button className="primary" disabled={busy} onClick={() => void decide(true)}>
                {t("approve")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}

export function Device() {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("code") ?? "");
  const [ask, setAsk] = useState<{ userCode: string; clientName: string; deviceName: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const look = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(undefined);
    try {
      setAsk(
        await json(
          await fetch(`/api/console/v1/oauth/device?code=${encodeURIComponent(code)}`, { credentials: "same-origin" }),
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const decide = async (approve: boolean) => {
    if (ask === undefined) return;
    try {
      await json(
        await fetch("/api/console/v1/oauth/device", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: ask.userCode, approve }),
        }),
      );
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <Card>
      <h1>{t("deviceTitle")}</h1>
      {error !== undefined ? <p className="error">{error}</p> : null}
      {done ? (
        <p className="muted">{t("deviceDone")}</p>
      ) : ask === undefined ? (
        <form onSubmit={(event) => void look(event)} className="stack">
          <p className="muted">{t("deviceLead")}</p>
          <label>
            <span>{t("deviceCode")}</span>
            <input
              className="code-input"
              value={code}
              autoCapitalize="characters"
              autoComplete="one-time-code"
              placeholder="ABCD-EFGH"
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </label>
          <button className="primary" type="submit">
            {t("deviceNext")}
          </button>
        </form>
      ) : (
        <>
          <p>{t("deviceAsk", { client: ask.clientName, device: ask.deviceName })}</p>
          <div className="actions">
            <button className="ghost" onClick={() => void decide(false)}>
              {t("deny")}
            </button>
            <button className="primary" onClick={() => void decide(true)}>
              {t("approve")}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
