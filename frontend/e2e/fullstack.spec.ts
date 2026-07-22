import { expect, test } from "@playwright/test";

test("real backend resource job refreshes the item and opens its reader product", async ({
  page,
  request,
}) => {
  const projectResponse = await request.post("/api/projects", {
    data: { name: "全栈资源验收", description: "真实前后端与临时数据工作区" },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = await projectResponse.json() as { id: string };
  const candidateResponse = await request.post(`/api/projects/${project.id}/candidates`, {
    data: {
      item: {
        item_type: "journalArticle",
        title: "Full-stack resource event contract",
        language: "en",
        issued_year: 2026,
      },
      source_provider: "fullstack-fixture",
      raw_payload: { fixture: true },
    },
  });
  expect(candidateResponse.ok()).toBe(true);
  const candidate = await candidateResponse.json() as { id: string };
  const decisionResponse = await request.post(
    `/api/projects/${project.id}/candidate-decisions`,
    { data: { decisions: [{ candidate_id: candidate.id, decision: "include", reason: "全栈验收" }] } },
  );
  expect(decisionResponse.ok()).toBe(true);
  const decisions = await decisionResponse.json() as Array<{
    project_item: { preferred_item_id: string };
  }>;
  const itemId = decisions[0]!.project_item.preferred_item_id;

  await page.goto(`/projects/${project.id}/items/${itemId}`);
  await page.getByRole("button", { name: "信息" }).tap();
  await page.getByText("从 HTTPS 获取", { exact: true }).tap();
  await page.getByPlaceholder("https://…").fill("https://papers.example.test/fullstack.pdf");
  await page.getByPlaceholder("可选文件名").fill("fullstack.pdf");
  await page.getByRole("button", { name: "创建获取任务" }).tap();

  await expect(page.getByText("任务已完成，附件列表已自动更新。")).toBeVisible();
  await expect(page.locator(".attachment-list")).toContainText("fullstack.pdf");
  const tracker = page.locator(".resource-job").filter({ hasText: "HTTPS 获取" });
  await expect(tracker).toContainText("已完成");
  await tracker.getByRole("link", { name: "查看任务" }).tap();
  const product = page.getByRole("link", { name: "打开输出附件" });
  await expect(product).toHaveAttribute(
    "href",
    new RegExp(`/projects/${project.id}/items/${itemId}/read/[a-f0-9]+\\?panel=pdf`),
  );
  await product.tap();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${project.id}/items/${itemId}/read/[a-f0-9]+\\?panel=pdf$`),
  );
  await expect(page.getByRole("button", { name: "版面" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
