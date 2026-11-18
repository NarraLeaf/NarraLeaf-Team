/**
 * How the team looks before anybody signs in: its name, accent, logo, the
 * sign-in picture and where it goes, and whether the server still needs
 * setting up. One read per page load, shared by every screen that asks.
 */
import { useEffect, useState } from "react";


export type SigninLayout = "center" | "left" | "right";

export interface TeamLook {
  readonly name: string;
  readonly accent?: string;
  readonly logoUrl?: string;
  readonly signinImageUrl?: string;
  readonly signinLayout: SigninLayout;
  readonly setupNeeded: boolean;
  /** Single sign-on, when an operator has set it up: what its button says. */
  readonly sso?: { readonly oidc?: string };
}

/** `#40a8c4` as the `64 168 196` the design tokens write colours in. */
function hexChannels(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`;
}

/**
 * Whether a team still has the name a server gives itself: nothing, or the
 * address it was reached at. Those are not names, so the console says
 * "NarraLeaf Team" and asks an operator to choose one.
 */
export function teamNameUnset(name: string | undefined): boolean {
  const value = (name ?? "").trim().toLowerCase();
  if (value === "" || value === "localhost" || value === location.hostname.toLowerCase()) return true;
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(value) || /^\[?[0-9a-f:]+\]?$/.test(value);
}

/** The team's name as people should read it. */
export function teamName(name: string | undefined): string {
  return teamNameUnset(name) ? "NarraLeaf Team" : (name ?? "").trim();
}

let pending: Promise<TeamLook> | undefined;

export function fetchLook(fresh = false): Promise<TeamLook> {
  if (pending === undefined || fresh) {
    pending = fetch("/api/console/v1/look", { credentials: "same-origin" })
      .then((response) => response.json() as Promise<TeamLook>)
      .then((look) => {
        if (look.accent !== undefined) {
          document.documentElement.style.setProperty("--nl-primary", hexChannels(look.accent));
        }
        document.title = teamName(look.name);
        return look;
      });
  }
  return pending;
}

/** The look, or undefined until it has arrived. */
export function useLook(): TeamLook | undefined {
  const [look, setLook] = useState<TeamLook | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetchLook()
      .then((found) => {
        if (alive) setLook(found);
      })
      .catch(() => {
        if (alive) setLook({ name: "NarraLeaf Team", signinLayout: "center", setupNeeded: false });
      });
    return () => {
      alive = false;
    };
  }, []);
  return look;
}
