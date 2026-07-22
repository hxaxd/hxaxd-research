import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";

import { AsyncMessage } from "../shared/ui/AsyncMessage";
import { AppDataProvider } from "./AppDataContext";
import { ResearchLayout } from "./layout/ResearchLayout";
import { DeviceAccessGate } from "../features/device-access/DeviceAccessGate";
import "./pages/pages.css";

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

function NotFoundPage() {
  return <section className="workspace-page not-found-page"><div><span>404</span><h1>这里没有可打开的内容</h1><p>地址可能已经失效，或者对应对象已被移除。</p><Link to="/">返回工作台</Link></div></section>;
}
export function AppRouter() {
  return (
    <DeviceAccessGate>
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
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        </BrowserRouter>
      </AppDataProvider>
    </DeviceAccessGate>
  );
}
