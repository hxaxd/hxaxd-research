import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { NavigationTree } from "../../features/navigation/NavigationTree";
import { Icon } from "../../shared/ui/Icon";
import "./layout.css";

export function ResearchLayout() {
  const location = useLocation();
  const [sidebarExpanded, setSidebarExpanded] = useState(
    () => !window.matchMedia("(max-width: 820px)").matches,
  );

  useEffect(() => {
    if (window.matchMedia("(max-width: 820px)").matches) setSidebarExpanded(false);
  }, [location.pathname]);

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
    </div>
  );
}
