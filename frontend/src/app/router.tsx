import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AsyncMessage } from "../shared/ui/AsyncMessage";
import { ResearchLayout } from "./layout/ResearchLayout";

const HomePage = lazy(() =>
  import("./pages/HomePage").then((module) => ({ default: module.HomePage })),
);
const ProjectPage = lazy(() =>
  import("./pages/ProjectPage").then((module) => ({ default: module.ProjectPage })),
);
const PaperPage = lazy(() =>
  import("./pages/PaperPage").then((module) => ({ default: module.PaperPage })),
);

function LoadingPage() {
  return <AsyncMessage kind="loading">正在打开页面…</AsyncMessage>;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<ResearchLayout />}>
          <Route
            index
            element={
              <Suspense fallback={<LoadingPage />}>
                <HomePage />
              </Suspense>
            }
          />
          <Route
            path="projects/:projectId"
            element={
              <Suspense fallback={<LoadingPage />}>
                <ProjectPage />
              </Suspense>
            }
          />
          <Route
            path="papers/:paperId"
            element={
              <Suspense fallback={<LoadingPage />}>
                <PaperPage />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
