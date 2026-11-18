/** "Set by your administrator", beside a setting an account policy has fixed. */
import type { ReactNode } from "react";

import { Icon } from "./Icon";
import { t } from "./i18n";

export function LockedNote({ children }: { children?: ReactNode }) {
  return (
    <span className="locked-note">
      <Icon name="lock" size={12} />
      {children ?? t("policyLocked")}
    </span>
  );
}
