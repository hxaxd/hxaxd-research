import { Outlet } from "react-router-dom";

import { NavigationTree } from "../../features/navigation/NavigationTree";
import "./layout.css";

export function ResearchLayout() {
  return (
    <div className="research-shell">
      <aside className="research-sidebar">
        <NavigationTree />
      </aside>
      <main className="research-main">
        <Outlet />
      </main>
    </div>
  );
}
