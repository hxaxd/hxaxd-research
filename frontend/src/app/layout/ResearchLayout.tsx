import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { NavigationTree } from "../../features/navigation/NavigationTree";
import { TaskPreferenceEffects } from "../../features/tasks/TaskPreferenceEffects";
import { Icon } from "../../shared/ui/Icon";
import "./layout.css";

const compactNavigationQuery = "(max-width: 1180px)";

export function ResearchLayout() {
  const location = useLocation();
  const [sidebarExpanded, setSidebarExpanded] = useState(
    () => !window.matchMedia(compactNavigationQuery).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(compactNavigationQuery);
    if (media.matches) setSidebarExpanded(false);
  }, [location.pathname]);

  useEffect(() => {
    const media = window.matchMedia(compactNavigationQuery);
    const syncNavigation = () => setSidebarExpanded(!media.matches);
    media.addEventListener("change", syncNavigation);
    return () => media.removeEventListener("change", syncNavigation);
  }, []);

  useEffect(() => {
    let revealTimer: number | null = null;
    const revealFocusedControl = () => {
      const focused = globalThis.document.activeElement;
      if (!(focused instanceof HTMLElement) || !focused.matches("input, textarea, select, [contenteditable='true']")) return;
      if (revealTimer !== null) window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(() => {
        focused.scrollIntoView({ block: "center", inline: "nearest" });
      }, 80);
    };
    window.addEventListener("resize", revealFocusedControl);
    window.visualViewport?.addEventListener("resize", revealFocusedControl);
    globalThis.document.addEventListener("focusin", revealFocusedControl);
    return () => {
      if (revealTimer !== null) window.clearTimeout(revealTimer);
      window.removeEventListener("resize", revealFocusedControl);
      window.visualViewport?.removeEventListener("resize", revealFocusedControl);
      globalThis.document.removeEventListener("focusin", revealFocusedControl);
    };
  }, []);

  return (
    <div className={sidebarExpanded ? "research-shell" : "research-shell research-shell--collapsed"}>
      <aside className="research-sidebar">
        <NavigationTree
          expanded={sidebarExpanded}
          onToggle={() => setSidebarExpanded((current) => !current)}
        />
      </aside>
      {sidebarExpanded ? (
        <button
          aria-label="关闭导航"
          className="sidebar-scrim"
          type="button"
          onClick={() => setSidebarExpanded(false)}
        />
      ) : null}
      <main className="research-main">
        {!sidebarExpanded ? (
          <button
            aria-label="打开导航"
            className="mobile-nav-trigger"
            title="打开导航"
            type="button"
            onClick={() => setSidebarExpanded(true)}
          >
            <Icon name="menu" size={19} />
          </button>
        ) : null}
        <Outlet />
      </main>
      <TaskPreferenceEffects />
    </div>
  );
}
