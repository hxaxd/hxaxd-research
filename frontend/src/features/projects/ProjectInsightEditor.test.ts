import { describe, expect, it } from "vitest";

import { splitValues } from "./ProjectInsightEditor";

describe("splitValues", () => {
  it("normalizes touch-entered roles and line lists", () => {
    expect(splitValues("核心论文， 方法,\n综述", /[,，\n]/)).toEqual(["核心论文", "方法", "综述"]);
    expect(splitValues("贡献一\n\n贡献二 ", /\n/)).toEqual(["贡献一", "贡献二"]);
  });
});
