/**
 * Light, dark, or whatever the system says - chosen per browser, applied
 * before the first paint by main.tsx so a page never flashes the other one.
 */
export type ThemeChoice = "system" | "light" | "dark";

export function chosenTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem("nlteam.theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice = chosenTheme()): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function chooseTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem("nlteam.theme");
    else localStorage.setItem("nlteam.theme", choice);
  } catch {
    /* nothing to remember with */
  }
  applyTheme(choice);
}
