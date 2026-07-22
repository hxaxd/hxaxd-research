import { useEffect, useState } from "react";

export type WorkspaceThemePreference = "system" | "light" | "dark";
export type ResolvedWorkspaceTheme = Exclude<WorkspaceThemePreference, "system">;

const storageKey = "hxaxd-workspace-theme";
const systemDarkQuery = "(prefers-color-scheme: dark)";
const themeColors: Record<ResolvedWorkspaceTheme, string> = {
  light: "#f2f0e5",
  dark: "#100f0f",
};

export function normalizeWorkspaceTheme(value: string | null): WorkspaceThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveWorkspaceTheme(
  preference: WorkspaceThemePreference,
  systemPrefersDark: boolean,
): ResolvedWorkspaceTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

export function workspaceThemeColor(theme: ResolvedWorkspaceTheme) {
  return themeColors[theme];
}

export function updateWorkspaceThemeColor(
  theme: ResolvedWorkspaceTheme,
  meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
) {
  meta?.setAttribute("content", workspaceThemeColor(theme));
}

function storedTheme(): WorkspaceThemePreference {
  try {
    return normalizeWorkspaceTheme(window.localStorage.getItem(storageKey));
  } catch {
    return "system";
  }
}

function applyTheme(preference: WorkspaceThemePreference) {
  const resolved = resolveWorkspaceTheme(
    preference,
    window.matchMedia(systemDarkQuery).matches,
  );
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  updateWorkspaceThemeColor(resolved);
}

export function initializeWorkspaceTheme() {
  applyTheme(storedTheme());
}

export function useWorkspaceTheme() {
  const [preference, setPreferenceState] = useState<WorkspaceThemePreference>(storedTheme);

  useEffect(() => {
    applyTheme(preference);
    const media = window.matchMedia(systemDarkQuery);
    const syncSystemTheme = () => {
      if (preference === "system") applyTheme(preference);
    };
    media.addEventListener("change", syncSystemTheme);
    return () => media.removeEventListener("change", syncSystemTheme);
  }, [preference]);

  function setPreference(next: WorkspaceThemePreference) {
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // The theme still applies for this session when storage is unavailable.
    }
    applyTheme(next);
    setPreferenceState(next);
  }

  return { preference, setPreference };
}
