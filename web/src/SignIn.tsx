/**
 * The pages before the console: signing in, and setting up a server nobody
 * has an account on yet.
 *
 * Sign-in is drawn one of four ways. Without a sign-in picture the form sits
 * in the middle of the page; with one, an operator chooses whether the picture
 * fills the page behind the form, or takes the left or the right half.
 */
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { setUp, signIn, SignInError, type ConsoleAccount } from "./api";
import { LanguagePicker } from "./Collab";
import { t } from "./i18n";
import { fetchLook, type SigninLayout, type TeamLook } from "./look";

export function TeamMark({ look, size = 28 }: { look: TeamLook | undefined; size?: number }) {
  if (look?.logoUrl !== undefined) {
    return <img className="team-mark" src={look.logoUrl} alt="" style={{ width: size, height: size }} />;
  }
  const letter = Array.from(look?.name ?? "N")[0]?.toUpperCase() ?? "N";
  return (
    <span className="team-mark team-mark-letter" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>
      {letter}
    </span>
  );
}

function Frame({ look, children }: { look: TeamLook; children: ReactNode }) {
  const layout: SigninLayout | "plain" = look.signinImageUrl === undefined ? "plain" : look.signinLayout;
  const picture = look.signinImageUrl;
  return (
    <main className={`gate gate-${layout}`}>
      {layout === "center" && picture !== undefined ? (
        <div className="gate-backdrop" aria-hidden="true">
          <img src={picture} alt="" />
        </div>
      ) : null}
      {(layout === "left" || layout === "right") && picture !== undefined ? (
        <section className="gate-picture" aria-hidden="true">
          <img src={picture} alt="" />
          <div className="gate-picture-brand">
            <TeamMark look={look} size={30} />
            <span>{look.name}</span>
          </div>
        </section>
      ) : null}
      <div className="gate-side">
        <div className="gate-card">
          {layout === "left" || layout === "right" ? null : (
            <div className="gate-brand">
              <TeamMark look={look} />
              <span>{look.name}</span>
            </div>
          )}
          {children}
        </div>
      </div>
    </main>
  );
}

export function SignIn({ look, hint, onSignedIn }: { look: TeamLook; hint?: string | undefined; onSignedIn: (account: ConsoleAccount) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(await signIn(username.trim(), password));
    } catch (caught) {
      setError(caught instanceof SignInError ? caught.message : String(caught));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame look={look}>
      <form className="gate-form" onSubmit={(event) => void submit(event)}>
        <div className="gate-title">
          <h1>{t("signInTitle")}</h1>
          <p className="muted">{hint ?? t("signInLead")}</p>
        </div>
        <label className="field">
          <span>{t("username")}</span>
          <input
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>{t("password")}</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {error === undefined ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary big" type="submit" disabled={busy}>
          {busy ? t("signingIn") : t("signIn")}
        </button>
        <p className="muted small">{t("forgotPassword")}</p>
        <div className="gate-foot">
          <span className="mono">{window.location.host}</span>
          <LanguagePicker />
        </div>
      </form>
    </Frame>
  );
}

type Step = "code" | "account" | "look";

/** The look without its picture: setting up is drawn plain, whatever is stored. */
function plain(look: TeamLook): TeamLook {
  const { signinImageUrl: _picture, ...rest } = look;
  return { ...rest, signinLayout: "center" };
}

/**
 * Setting up: the code `up` printed, the first account, and how the team
 * looks. The account is made at the last step, so going back loses nothing;
 * pictures are sent once it exists, because sending one needs an operator.
 */
export function Setup({ look, onDone }: { look: TeamLook; onDone: (account: ConsoleAccount) => void }) {
  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [serverName, setServerName] = useState(look.name);
  const [accent, setAccent] = useState(look.accent ?? "#40a8c4");
  const [logo, setLogo] = useState<File | undefined>(undefined);
  const [picture, setPicture] = useState<File | undefined>(undefined);
  const [layout, setLayout] = useState<SigninLayout>("center");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const logoPicker = useRef<HTMLInputElement>(null);
  const picturePicker = useRef<HTMLInputElement>(null);

  const steps: readonly Step[] = ["code", "account", "look"];
  const index = steps.indexOf(step);

  const next = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (step === "code") {
      if (code.replace(/[^a-z0-9]/gi, "").length !== 8) {
        setError(t("setupCodeShape"));
        return;
      }
      setStep("account");
      return;
    }
    if (step === "account") {
      if (password.length < 12) {
        setError(t("setupPasswordShort"));
        return;
      }
      if (password !== again) {
        setError(t("setupPasswordMismatch"));
        return;
      }
      setStep("look");
      return;
    }
    void finish();
  };

  const put = async (path: string, file: File) => {
    const response = await fetch(path, { method: "PUT", credentials: "same-origin", headers: { "content-type": file.type }, body: file });
    if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? response.statusText);
  };

  const finish = async () => {
    setBusy(true);
    try {
      const account = await setUp({
        code,
        username: username.trim(),
        password,
        ...(displayName.trim() === "" ? {} : { displayName: displayName.trim() }),
        ...(serverName.trim() === "" ? {} : { serverName: serverName.trim() }),
        accent,
      });
      // The account exists from here on; a picture that fails to send is
      // something to fix in the admin page, not a reason to stay on this one.
      try {
        if (logo !== undefined) await put("/api/console/v1/brand/logo", logo);
        if (picture !== undefined) {
          await put("/api/console/v1/brand/signin-image", picture);
        }
      } catch {
        /* see above */
      }
      if (picture !== undefined && layout !== "center") {
        // The layout travels on the socket, which the console opens next; the
        // sign-in page reads it from there. Kept for the shell to send.
        sessionStorage.setItem("nlteam.setupLayout", layout);
      }
      await fetchLook(true);
      onDone(account);
    } catch (caught) {
      setError(caught instanceof SignInError ? caught.message : String(caught));
      if (caught instanceof SignInError && caught.status === 401) setStep("code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame look={plain(look)}>
      <form className="gate-form setup" onSubmit={next}>
        <ol className="setup-steps" aria-label={t("setupTitle")}>
          {steps.map((key, at) => (
            <li key={key} className={at === index ? "current" : at < index ? "done" : undefined} aria-current={at === index ? "step" : undefined}>
              <span className="setup-dot">{at + 1}</span>
              {t(key === "code" ? "setupStepCode" : key === "account" ? "setupStepAccount" : "setupStepLook")}
            </li>
          ))}
        </ol>

        {step === "code" ? (
          <>
            <div className="gate-title">
              <h1>{t("setupTitle")}</h1>
              <p className="muted">{t("setupCodeLead")}</p>
            </div>
            <label className="field">
              <span>{t("setupCode")}</span>
              <input
                className="code-input"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                spellCheck={false}
                required
              />
            </label>
            <pre className="setup-hint">{t("setupCodeWhere")}</pre>
          </>
        ) : null}

        {step === "account" ? (
          <>
            <div className="gate-title">
              <h1>{t("setupAccountTitle")}</h1>
              <p className="muted">{t("setupAccountLead")}</p>
            </div>
            <label className="field">
              <span>{t("username")}</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoCapitalize="none" spellCheck={false} autoComplete="username" required />
            </label>
            <label className="field">
              <span>{t("displayName")}</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={username} />
            </label>
            <label className="field">
              <span>{t("password")}</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
            </label>
            <label className="field">
              <span>{t("setupPasswordAgain")}</span>
              <input type="password" value={again} onChange={(event) => setAgain(event.target.value)} autoComplete="new-password" required />
            </label>
          </>
        ) : null}

        {step === "look" ? (
          <>
            <div className="gate-title">
              <h1>{t("setupLookTitle")}</h1>
              <p className="muted">{t("setupLookLead")}</p>
            </div>
            <label className="field">
              <span>{t("teamName")}</span>
              <input value={serverName} onChange={(event) => setServerName(event.target.value)} maxLength={64} />
            </label>
            <label className="field">
              <span>{t("accentColour")}</span>
              <span className="field-row">
                <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} />
                <code>{accent}</code>
              </span>
            </label>
            <div className="field">
              <span>{t("logo")}</span>
              <span className="field-row">
                <button type="button" className="ghost outline" onClick={() => logoPicker.current?.click()}>
                  {logo === undefined ? t("changeLogo") : logo.name}
                </button>
                <input ref={logoPicker} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => setLogo(event.target.files?.[0])} />
              </span>
            </div>
            <div className="field">
              <span>{t("signinPicture")}</span>
              <span className="field-row">
                <button type="button" className="ghost outline" onClick={() => picturePicker.current?.click()}>
                  {picture === undefined ? t("signinChoosePicture") : picture.name}
                </button>
                <input ref={picturePicker} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => setPicture(event.target.files?.[0])} />
              </span>
            </div>
            {picture !== undefined ? (
              <fieldset className="field layout-choice">
                <legend>{t("signinLayout")}</legend>
                {(["center", "left", "right"] as const).map((value) => (
                  <label key={value} className={layout === value ? "layout-option active" : "layout-option"}>
                    <input type="radio" name="setup-layout" value={value} checked={layout === value} onChange={() => setLayout(value)} />
                    <span className={`layout-sketch layout-sketch-${value}`} aria-hidden="true">
                      <span className="sketch-picture" />
                      <span className="sketch-form" />
                    </span>
                    <span>{t(value === "center" ? "signinLayoutCenter" : value === "left" ? "signinLayoutLeft" : "signinLayoutRight")}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            <p className="muted small">{t("setupLaterHint")}</p>
          </>
        ) : null}

        {error === undefined ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="setup-actions">
          {index > 0 ? (
            <button type="button" className="ghost outline" onClick={() => setStep(steps[index - 1] ?? "code")} disabled={busy}>
              {t("back")}
            </button>
          ) : null}
          <button className="primary big" type="submit" disabled={busy}>
            {step === "look" ? (busy ? t("setupFinishing") : t("setupFinish")) : t("next")}
          </button>
        </div>
      </form>
    </Frame>
  );
}
