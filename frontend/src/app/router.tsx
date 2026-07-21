import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AsyncMessage } from "../shared/ui/AsyncMessage";
import { AppDataProvider } from "./AppDataContext";
import { ResearchLayout } from "./layout/ResearchLayout";

const HomePage = lazy(() => import("./pages/HomePage").then((module) => ({ default: module.HomePage })));
const ProjectPage = lazy(() => import("./pages/ProjectPage").then((module) => ({ default: module.ProjectPage })));
const ItemPage = lazy(() => import("./pages/ItemPage").then((module) => ({ default: module.ItemPage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then((module) => ({ default: module.TasksPage })));
const AgentRunPage = lazy(() => import("./pages/AgentRunPage").then((module) => ({ default: module.AgentRunPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((module) => ({ default: module.IntegrationsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

function LoadingPage() {
  return <AsyncMessage kind="loading">正在打开工作区…</AsyncMessage>;
}
export function AppRouter() {
  return (
    <AppDataProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<ResearchLayout />}>
            <Route index element={<Suspense fallback={<LoadingPage />}><HomePage /></Suspense>} />
            <Route path="projects/:projectId" element={<Suspense fallback={<LoadingPage />}><ProjectPage /></Suspense>} />
            <Route path="projects/:projectId/items/:itemId" element={<Suspense fallback={<LoadingPage />}><ItemPage /></Suspense>} />
            <Route path="projects/:projectId/items/:itemId/read/:attachmentId" element={<Suspense fallback={<LoadingPage />}><ItemPage /></Suspense>} />
            <Route path="tasks" element={<Suspense fallback={<LoadingPage />}><TasksPage /></Suspense>} />
            <Route path="agent-runs/:runId" element={<Suspense fallback={<LoadingPage />}><AgentRunPage /></Suspense>} />
            <Route path="integrations" element={<Suspense fallback={<LoadingPage />}><IntegrationsPage /></Suspense>} />
            <Route path="settings" element={<Suspense fallback={<LoadingPage />}><SettingsPage /></Suspense>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppDataProvider>
  );
}
