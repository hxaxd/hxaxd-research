# 论文写作模板整理版

## 0. 核心思想

写论文的关键不是先写英文句子，而是先把论文的 story、technical challenge、method pipeline、experiments 和 reviewer 可能质疑的问题想清楚。

最重要的原则有两条：

1. **先理清写作思路，再动手写。**
2. **反复修改写作思路和英文表达。**

一篇论文要让 reviewer 第一眼觉得高级，除了技术内容本身，还要重视视觉呈现：teaser figure、pipeline figure、表格、结果图和排版。

---

## 1. 论文写作总流程

### 1.1 写论文步骤

1. 画一个清楚的 pipeline figure 草图。
   - 待补充：论文画图模板（原笔记未公开）。
2. 梳理论文 story，写 Introduction 的写作思路，并整理 comparison experiments 和 ablation studies。
   - 如何梳理论文 story。
   - 如何列写作思路。
   - 如何整理要做的实验。
3. 列 Method 的写作思路，然后写 Method，同时做实验。
   - 如何写 Method。
   - 如何列写作思路。
   - 如何使用 Copilot 和 GPT 辅助英语写作。
4. 修改 Introduction 和 Method，同时继续做实验。
   - 如何改论文写作。
5. 实验做得差不多以后，列 Experiment 的写作思路，然后写 Experiment。
   - 如何列写作思路。
   - 如何使用 Copilot 和 GPT 辅助英语写作。
   - 如何画实验表格。
6. 美化 pipeline figure，画论文 teaser 图。
   - 待补充：论文画图模板（原笔记未公开）。
7. 列 Related Work 的写作思路，然后写 Related Work。
   - 如何写 Related Work。
   - 如何列写作思路。
   - 如何使用 Copilot 和 GPT 辅助英语写作。
8. Review 论文，修改 Introduction、Method 和 Experiment。
   - 如何 Review 论文。
   - 如何改论文写作。
9. 列 Abstract 的写作思路，然后写 Abstract。
   - 如何写 Abstract。
   - 如何列写作思路。
   - 如何使用 Copilot 和 GPT 辅助英语写作。
10. 取论文标题。
    - 如何取论文标题。
11. 反复 review 论文，反复修改。
    - 如何 Review 论文。
    - 如何改论文写作。

### 1.2 获得好 review 的关键

论文收获好 review 的一个重要因素是：论文要做得漂亮、美观，让 reviewer 第一印象觉得这篇论文很高级。

让论文第一眼看起来漂亮、高级的方法：

1. 做好看的 teaser figure 和 pipeline figure。
2. 做好看的表格和结果图。
3. 保持整齐的排版。

---

## 2. 段落与英语写作原则

### 2.1 段落写作原则

1. 一段文字只讲一个 message，不要把多个 messages 混在一起。
2. 一段开头第一句就要让读者知道这一段在说什么。
3. 段落内部要符合金字塔原理：塔尖是观点，塔基是支撑观点的逻辑和论据。

### 2.2 英语写作基本思路

英语写作不是直接写英文句子，而是：

1. 先列写作思路。
2. 再细化每一部分的思路。
3. 最后写具体英文句子。
4. 写完后检查段落、句子之间的 flow。

### 2.3 判断段落是否清楚

从读者角度检查：

1. 这一段是否有明确主题？
2. 第一句话是否讲清楚本段要说什么？
3. 句子中的每一个名词和概念，读者是否都能读懂？是否 self-contained？
4. 相邻句子之间的逻辑是否连续？
5. 能否做 reverse-outlining：根据已经写出的段落反推出写作思路，并检查思路是否通顺？

---

## 3. 论文写作时间规划

一般情况下，至少要在截稿前一个月开始写论文。

截稿前一个月，method 可能还没有完全定下来，实验也可能没有全部做完。但通常 story 已经基本确定，所以可以开始写论文，并反过来帮助自己规划实验。

### 3.1 截稿前四周

主要任务：

1. 整理现有 story，包括 core contribution、方法模块及其 motivation。
2. 列出 comparison experiments 和 ablation studies。
3. 写 Introduction 初稿。

### 3.2 截稿前三周

这一周最好能把方法定下来。

主要任务：

1. 把 pipeline figure 的流程图草图画清楚并定下来。
2. 确认 pipeline figure 后，写 Method 初稿。
3. 如果方法细节还没定下来，在相应位置写 `\todo{}`，先把 Method 框架搭出来。

关键要求：

> 这一周结束前，必须把 Introduction 和 Method 初稿给导师改。否则导师最后几天可能根本改不完。

### 3.3 截稿前两周

主要任务：

1. 写 Experiments 初稿。
2. 写 Abstract 初稿。
3. 写 Related Work 初稿。

### 3.4 截稿最后一周

主要任务：

1. 改论文。
2. 美化 pipeline figure 和 teaser。
3. 做 demo。
4. 做最后的自我 review。

### 3.5 投稿进度表

建议用投稿进度表管理多个项目，避免导师或合作者在最后阶段同时面对过多未完成论文。

| Project lead | Introduction | Method | Experiments | Related Work | Abstract | Title |
|---|---|---|---|---|---|---|
| xxx | 描述具体进展 | xxx | xxx | xxx | xxx | xxx |

---

## 4. 论文标题

标题很重要，因为不同标题可能吸引不同领域的 reviewers。

起标题前，先写下一些重要关键词，再根据这些关键词起标题。

好标题的要求：

1. informative：能提供具体信息。
2. 包含任务、技术、问题或核心方法。
3. 方法短语要有具体含义，便于读者记住。

标题可以包含的信息：

- 使用的技术。
- 论文的任务。
- 论文解决的问题。
- 方法的核心 insight。

---

## 5. Abstract 写作模板

写好 Abstract 的步骤：

1. 想清楚 Abstract 的写作思路。
2. 套用合适模板。
3. 反复修改。

写 Abstract 前，先回答四个问题：

1. 我们解决的 technical problem 是什么？为什么这个问题没有 well-established solution？
2. 我们的 technical contribution 是什么？
3. 我们方法本质上为什么能 work？
4. 我们方法的 technical advantage 是什么？我们带来了什么新认知？

### 5.1 Abstract 模板一：technical challenge → contribution

```latex
\section{Abstract}
% Task
% Technical challenge for previous methods
% 一两句话介绍解决 challenge 的 technical contribution
% 介绍 technical contribution 的好处
% Experiment
```

适用场景：

- 论文主要围绕一个清晰 technical challenge 展开。
- 方法贡献可以用一两个技术名词清楚概括。

### 5.2 Abstract 模板二：technical challenge → insight → contribution

```latex
\section{Abstract}
% Task
% Technical challenge for previous methods
% 一句话介绍解决 challenge 的 insight
% 一两句话介绍实现 insight 的 technical contribution
% 介绍 technical novelty 的好处
% Experiment
```

这是原笔记中更推荐的写法。

适用场景：

- 论文有一个核心 insight。
- 方法不是简单堆模块，而是由 insight 自然推出 pipeline。

### 5.3 Abstract 模板三：多个 technical contributions

```latex
% Task
% Technical contribution 1 + technical advantage 1
% Technical contribution 2 + technical advantage 2
% Technical contribution 3 + technical advantage 3
% Experiment
```

适用场景：

- 论文贡献是多个模块或多个设计点。
- 每个 contribution 都能对应一个清楚的 advantage。

---

## 6. Introduction 写作模板

写好 Introduction 的步骤：

1. 想清楚 Introduction 的写作思路。
2. 套用模板。
3. 反复修改。

### 6.1 倒推 Introduction

先倒推回答：

1. 我们解决的 technical problem 是什么？为什么没有 well-established solution？
2. Our pipeline 的 contributions 是什么？例如新任务、新指标、新技术问题、新技术。
3. 我们的 contributions 有什么好处？为什么能解决 technical challenge？带来了什么新认知？
4. 怎么通过讨论 previous methods 引出我们解决的 technical challenge 和新认知？

### 6.2 正推 Introduction

再正推形成 story：

1. 介绍论文 task。
2. 通过讨论 previous methods 引出 technical challenge。
3. 为了解决这个 challenge，提出我们的 contributions。
4. 说明 contributions 的技术优势和新认知。

### 6.3 Introduction 总模板

```latex
\section{Introduction}
% Task and application
% Technical challenge for previous methods
% 介绍解决 challenge 的 our pipeline
% Experiment
% Contributions
```

---

## 7. Introduction 第一部分：Task and Application

### 7.1 版本一：Task 小众，先介绍 Task，再介绍 Application

```text
[xxx task] targets at recovering/reconstructing/estimating [xxx 输出] from [xxx 输入].
[xxx task] has a variety of applications such as [xxx], [xxx], and [xxx].
```

### 7.2 版本二：Task 熟悉，直接介绍 Application

```text
[xxx task] has a variety of applications such as [xxx], [xxx], and [xxx].
```

### 7.3 版本三：先介绍 general task，再介绍 specific setting

```text
[xxx task] has a variety of applications such as [xxx], [xxx], and [xxx].
This paper focuses on the specific setting of recovering/reconstructing/estimating [xxx 输出] from [xxx 输入].
```

适用场景：

- general task 比较常见。
- 你的具体 setting 比较新。

### 7.4 版本四：第一段直接引出 technical challenge

适用场景较少，但如果合适，Introduction 第一段就讲清楚要解决的事情，效果很好。

结构：

1. 介绍 task 和 application。
2. 通过 previous methods 直接引出 technical challenge。

---

## 8. Introduction 第二部分：Technical Challenge

这一部分非常重要。目标是让读者产生好奇：为什么这个 challenge 重要？为什么现有方法解决不好？为什么需要你的方法？

### 8.1 Existing task：已有方法存在

写之前先想清楚：

1. 我们的 pipeline 解决了什么 technical challenge？
2. 哪类 recent method 存在这个 challenge？
3. 这类 recent method 为什么会存在？它原本是为了解决谁的问题？
4. 更早的 traditional method 又解决了什么、留下了什么问题？

通用模板：

```text
This problem is particularly challenging due to several factors, including [xxx 原因], [xxx 原因], and [xxx 原因].

To overcome these challenges, traditional methods [描述怎么做的], [达到了怎样的效果]. However, they [面临的 technical challenge].

Recently, [xxx methods] [描述怎么做的], [达到了怎样的效果]. However, they [存在的 limitation], because [xxx technical reason].

To overcome this challenge, [xxx methods] [描述怎么做的], [达到了怎样的效果]. However, they [存在的 limitation], because [xxx technical reason].
```

### 8.2 Existing task：你的 insight 在传统方法中出现过

适用场景：

- 你的 contribution 不是凭空产生，而是把传统方法中的某个 insight 用新技术重新实现。
- 这样写能给你的方法提供“传统方法背书”。

通用模板：

```text
Traditional/recent methods [描述怎么做的], [达到了怎样的效果]. However, they [存在的 limitation], because [xxx technical reason].

To overcome this problem, a typical approach is [xxx insight], which has long been explored in literature. These methods [描述怎么做的]. However, they [存在的 limitation], because [xxx technical reason].

To overcome this challenge, [xxx methods] [描述怎么做的], [达到了怎样的效果]. However, they [存在的 limitation], because [xxx technical reason].
```

### 8.3 Novel task：没有已有方法

不要先写一个 naive solution，然后再写我们如何改进。这样容易让 reviewer 觉得方法只是 straightforward 的四分改进。

更好的写法是：直接描述为了实现目标，需要满足哪些 requirements 或面临哪些 challenges。

通用模板：

```text
In this work, our goal is to [xxx]. This problem is challenging for several reasons.

First, [challenge 1].

Second, [challenge 2].

Finally, [challenge 3].
```

---

## 9. Introduction 第三部分：Our Pipeline

写之前先回答：

1. 我们的 pipeline 解决了什么 technical challenge？
2. 我们的 technical contribution 是什么？
3. 方法本质上为什么 work？
4. 相比之前方法有什么好处？

### 9.1 模板一：一个 contribution，多个 advantages

```text
In this paper, we propose a novel framework/representation, named [方法名字] for [xxx task].The basic idea is illustrated in [xxx Figure].Our innovation is in [一句话介绍 key novelty].Specifically, [讲具体怎么做的].
In contrast to previous methods, [我们方法的 advantage].Another advantage of the proposed method is that [另一个 advantage].
```

### 9.2 模板二：两个 contributions

```text
In this paper, we propose a novel framework/representation, named [方法名字] for [xxx task].Our innovation is in [一句话介绍 key novelty].The basic idea is illustrated in [xxx Figure].
Specifically, [讲具体怎么做的].In contrast to previous methods, [我们方法的 advantage].

However, [描述另一个 technical challenge].Specifically, [讲 contribution 2 具体怎么做].
```

### 9.3 模板三：基于已有 pipeline，提出新 module

适用场景：

- 整体 pipeline 沿用之前方法。
- 主要 novelty 是一个新的 module。

写法：

1. 说明基于 previous methods。
2. 说明新的 module 是什么。
3. 说明它解决了什么结构性问题。
4. 解释为什么比通用方案更合适。

### 9.4 模板四：contribution 来自重要 observation

结构：

1. 先介绍 key innovation。
2. 讨论一个直观、读者能听懂的 observation。
3. 根据 observation 推出具体方法。
4. 说明方法好处。

### 9.5 不推荐写法

不推荐在 Introduction 中只讲抽象 insight，不讲清楚 pipeline。

原因：

- reviewer 可能觉得你在“包装”而不是贡献。
- Introduction 应该尽量讲清楚核心贡献具体怎么做。
- 真正的功夫不是把 insight 讲玄，而是把一个简单 pipeline 讲得自然、有动机、有新意。

---

## 10. Method 写作模板

Method 写清楚的步骤：

1. 回答方法模块问题。
2. 画 pipeline figure 草图。
3. 按步骤写 Method。

### 10.1 写 Method 前要回答的问题

1. 论文方法有哪些模块？
2. 每个模块的工作流程是什么？
3. 为什么要用这个模块？
4. 这个模块为什么 work？

建议把这些回答整理成脑图或表格。

### 10.2 Method 写作步骤

1. 画 pipeline figure 草图。
2. 根据 pipeline figure 组织 Method section：每个 subsection 写一个方法模块。
3. 组织每个 subsection 的写作思路。
4. 每个 subsection 包含三部分：
   - Motivation of this module。
   - Module design。
   - Technical advantages of this module。
5. 具体写作时，先写 module design，让 Method 有基本内容。
6. 再补 motivation 和 technical advantages。

### 10.3 Pipeline module 三元素

| 元素 | 作用 | 需要回答的问题 |
|---|---|---|
| Module design | 描述模块细节 | 输入是什么？步骤是什么？输出是什么？representation、network、algorithm 如何构造？ |
| Motivation of this module | 解释为什么需要这个模块 | 这个模块解决什么问题？为什么不用更简单方案？ |
| Technical advantages | 解释为什么这个模块有技术优势 | 为什么它 work？相比已有方法或替代设计有什么优势？ |

### 10.4 Method 总模板

```latex
\section{Method}
% Overview
% Section 3.1
% Section 3.2
% Section 3.3
```

### 10.5 Overview 模板

```text
Given [输入/setting], our task is to [输出/目标].We build upon / are inspired by [previous work], and our core contribution is [核心贡献].The overview of the proposed model is illustrated in Figure [x].

Section 3.1 describes [模块 1].Section 3.2 discusses [模块 2].Section 3.3 introduces [模块 3].
```

### 10.6 Section 3.1 / 3.2 / 3.3 模板

每个模块 subsection 推荐结构：

1. Motivation of this module。
2. Module forward process / Module design。
3. Technical advantages of this module。
4. Implementation details。

Implementation details 可以包括：

- 网络层数。
- feature vector 维度。
- 坐标变换。
- 坐标归一化。
- 关键超参。

### 10.7 Method 自检清单

1. Method 的写作思路是否流畅？
2. 每个段落开头第一句是否讲清楚本段主题？
3. 一段是否只表达一件事？
4. 每句话的动机是否清楚？
5. 读者是否时刻知道为什么要执行当前句子里的操作？
6. 句子之间是否有 flow？
7. 论文中的名词是否一致？不要频繁换说法。

---

## 11. 论文画图

Method figure 很重要。

原则：

1. pipeline 图需要和之前方法不一样，否则会给 reviewer 没有 novelty 的印象。
2. 如果整个 pipeline 从输入到输出不是很 novel，就应该在图中突出 novel module。
3. 也可以不画大图，只画几个小图，但论文整体美感可能下降。
4. pipeline 图不是主要用来让读者完全看懂方法的，而是用来突出 novelty 的。
5. Method 文字部分才是让读者真正看懂方法的地方。

原笔记提到：

- 正面例子：NSFF、KiloNeRF。
- 反面例子：AniSDF。

待补充：原笔记中的未公开画图模板和图像示例。

---

## 12. 论文画表

参考链接：<https://x.com/jbhuang0604/status/1626372600824844289>

表格美化原则：

1. Caption 放在 Table 上面。
2. 尽量不用竖线。
3. 不要用 `\hline`，改用 `\toprule`、`\midrule`、`\bottomrule`。
4. 尽量少用横线，避免扰乱视觉。
5. 对 highlight 的数字上颜色。

---

## 13. Experiments 写作模板

要写出好的 Experiments，需要回答三个问题：

1. 怎么证明我们的方法比已有方法更强？对应 comparison experiments。
2. 怎么证明方法里的 module 有效？对应 ablation studies。
3. 怎么充分展示方法上限？对应 challenging demo / applications。

### 13.1 Experiments 文字重点

Experiments 中非常重要的是 figure caption 和 table caption。

Caption 需要写清楚：

1. experimental setting。
2. notation。
3. 如果没什么可说，可以简单说一句实验结果。

Caption 不要大篇幅讨论实验结果，否则容易和正文重复。

### 13.2 图表排版技巧

单栏图表放在论文右栏通常更好看，因为人的阅读习惯会从左上角找正文第一行。

### 13.3 Comparison experiments

如果有 baseline methods：

- 需要和相关的、较新的 baseline methods 比较。

如果任务很新，没有直接 baseline：

- 可以构造方法 variants。
- 可以把已有方法改造成适配该任务的 baseline。
- 可以设计合理的 naive / oracle / upper-bound 版本辅助说明。

### 13.4 Ablation studies

Ablation studies 通常包含两部分。

第一部分：一个大表和对应可视化对比图。

目的：展示 core contributions 和重要 components 对 performance 的影响。

第二部分：若干小表和对应可视化图。

目的：分析每个 pipeline module 内部 design choices 的影响，例如：

- 超参敏感性。
- input data 质量敏感性。
- 去掉某个 design choice 后的性能变化。

### 13.5 Applications / Demo

Applications 和 demo 对论文影响力很大。

它们的作用不是只证明 metric，而是展示：

1. 方法能解决真实问题。
2. 方法上限高。
3. 结果有视觉冲击力。
4. reviewer 第一眼觉得工作完整、漂亮、有潜力。

---

## 14. Related Work 写作模板

写好 Related Work 的步骤：

1. 先列出和自己论文方法最相关的论文。
2. 根据研究方向和算法技术，确定 Related Work 要讨论的 topics。
3. 在每个 topic 下列出需要讨论的论文。
4. 基于这些论文组织 Related Work 的写作思路。

注意：

- Related Work 中最重要的是讨论和自己方法最相关的工作。
- 如果漏掉关键相关工作，reviewer 可能直接以此拒稿。

---

## 15. Conclusion 与 Limitation

Conclusion 除了常规总结，最好写 Limitation。否则 reviewer 经常会把“没写 limitation”作为 weakness。

### 15.1 Limitation 怎么写

Limitation 一般写因为 task goal 或 task setting 导致的 limitation，类似 future work。

不建议直接暴露严重技术缺陷。

示例：

```text
Common videos are more than a few minutes. However, this work only deals with videos of 100 to 300 frames, which are relatively short, thus limiting the applications. How to model a long volumetric video remains an interesting problem.
```

### 15.2 技术缺陷 vs task setting limitation

这两者边界比较模糊。

一个实用判断是：

> 只要不低于目前 SOTA 方法的 metric，就不太像严重技术缺陷，更像 future work 或 setting limitation。

例如：

- 如果算法显存更小，但训练时间更长，且训练时间是已有重要 metric，那么可能会被认为是严重 limitation。
- 如果当前领域 SOTA 基本都只能处理短视频，那么“只能处理 100 到 300 帧视频”更像 future work，而不是明显技术缺陷。

---

## 16. 怎么改论文

在论文最后加一个自我评审 question list，从五方面检查论文。

### 16.1 Contribution 不够

常见问题：

1. 论文没有给读者带来新的知识。
2. 想解决的 failure cases 很常见，但方法不够新。
3. 提出的技术已经被 well-explored。
4. performance improvement 是可预见的 / well-known 的。
5. 技术比较 straightforward。

### 16.2 写作不清楚

常见问题：

1. 缺少技术细节，不可复现。
2. 某个方法模块缺少 motivation。
3. 读者看不懂关键概念。
4. 段落之间或句子之间没有 flow。

### 16.3 实验效果不够好

常见问题：

1. 只比之前方法好一点。
2. 虽然超过之前方法，但绝对效果仍然不够好。
3. 视觉结果没有说服力。

### 16.4 实验测试不充分

常见问题：

1. 缺少 ablation studies。
2. 缺少重要 baselines。
3. 缺少重要 evaluation metric。
4. 数据太简单，无法证明方法真的 work。

### 16.5 方法设计有问题

常见问题：

1. 实验 setting 不实际。
2. 方法存在技术缺陷，看起来不合理。
3. 方法不鲁棒，需要每个场景调超参。
4. 新方法带来 benefit 的同时，引入更强 limitation，导致收益为负。

### 16.6 Claim 检查

论文中所有 claim，特别是 Abstract 和 Introduction 里的 claim，都不能犯错，而且需要有实验 support。

否则 reviewer 可能直接据此拒稿。

### 16.7 Adversarial Writing

Adversarial writing 的意思是：自己像 reviewer 一样审稿，提前考虑 reviewer 可能会问的所有问题，并逐一解决。

建议：

1. 请导师尽早给修改意见。
2. 导师提出的问题越多越好。
3. 这些问题如果提前修掉，reviewer 能抓到的问题就更少。
4. 追求完美主义是保证论文质量的重要方式。

---

# 17. 中英术语对照表

| 英文术语 | 中文解释 | 在论文写作中的含义 |
|---|---|---|
| Abstract | 摘要 | 论文开头的高度浓缩版本，说明任务、挑战、贡献、优势和实验结果。 |
| Introduction | 引言 | 建立问题背景，引出技术挑战，说明本文贡献和价值。 |
| Method | 方法 | 详细描述论文提出的方法、模块、公式、流程和实现。 |
| Experiment(s) | 实验 | 证明方法有效、模块有用、结果有优势的部分。 |
| Related Work | 相关工作 | 梳理前人工作，并说明本文和它们的区别。 |
| Conclusion | 结论 | 总结工作贡献，通常附带 limitation 和 future work。 |
| Limitation | 局限性 | 方法在 task goal、setting 或应用范围上的限制。 |
| Future Work | 未来工作 | 后续可以继续研究的问题。 |
| Reviewer | 审稿人 | 评审论文的人。 |
| Review | 审稿意见 / 评审 | 对论文优缺点、接收与否的评价。 |
| Rebuttal | 回复审稿 | 作者对审稿意见的回应。 |
| Story | 论文叙事 | 论文如何从问题、挑战、方法到实验形成一个顺畅逻辑。 |
| Task | 任务 | 论文解决的具体问题，如分类、生成、检测、规划等。 |
| Application | 应用 | 该任务在真实场景中的价值。 |
| Setting | 问题设定 | 输入、输出、约束、数据条件等。 |
| Technical problem | 技术问题 | 论文要解决的具体技术障碍。 |
| Technical challenge | 技术挑战 | 现有方法难以解决的关键困难。 |
| Technical contribution | 技术贡献 | 本文提出的新技术、新模块、新任务、新指标或新 insight。 |
| Technical advantage | 技术优势 | 本文方法相比已有方法的好处。 |
| Technical novelty | 技术新颖性 | 方法中真正新的部分。 |
| Insight | 洞察 | 支撑方法设计的核心认知。 |
| Observation | 观察 | 从问题、数据或现有方法中发现的现象，用来引出方法。 |
| Pipeline | 流水线 / 方法流程 | 从输入到输出的方法整体流程。 |
| Pipeline figure | 方法流程图 | 展示方法整体结构和 novelty 的图。 |
| Teaser figure | 摘要图 / 引导图 | 论文首页吸引读者的核心图。 |
| Module | 模块 | 方法中的一个组成部分。 |
| Module design | 模块设计 | 模块具体怎么运行、输入输出是什么。 |
| Motivation | 动机 | 为什么需要这个模块或这个设计。 |
| Core contribution | 核心贡献 | 论文最重要的新东西。 |
| Baseline | 基线方法 | 用来比较的已有方法或简单方法。 |
| Comparison experiment | 对比实验 | 证明本文方法比已有方法更强。 |
| Ablation study | 消融实验 | 去掉或替换某个模块，证明该模块有效。 |
| Variant | 变体 | 方法的不同版本，常用于消融或对比。 |
| Evaluation metric | 评价指标 | 衡量方法效果的量化指标。 |
| SOTA | State of the Art，当前最佳 | 当前领域公开结果中最强的方法或结果。 |
| Demo | 演示 | 展示方法实际效果或上限的案例。 |
| Caption | 图表说明 | Figure/Table 的说明文字。 |
| Experimental setting | 实验设定 | 数据集、指标、配置、训练测试条件等。 |
| Notation | 符号说明 | 公式或图表中符号的定义。 |
| Flow | 行文流畅性 / 逻辑流 | 句子、段落之间是否自然衔接。 |
| Self-contained | 自包含 | 读者不依赖额外信息也能理解当前句子或段落。 |
| Reverse-outlining | 反向提纲 | 从已写段落反推出写作思路，检查逻辑是否通顺。 |
| Well-established solution | 成熟解决方案 | 已经被公认有效、基本解决该问题的方法。 |
| Failure case | 失败案例 | 现有方法做不好的典型情况。 |
| Straightforward | 直接的 / 显然的 | reviewer 可能认为太容易想到，创新性不足。 |
| Well-explored | 已被充分研究 | 该技术方向已有大量工作，创新空间可能有限。 |
| Claim | 论断 | 论文中声称的方法能力、贡献、结果或结论。 |
| Support | 支撑证据 | 支撑 claim 的实验、理论、分析或可视化。 |
| Adversarial writing | 对抗式写作 | 站在 reviewer 角度主动攻击自己的论文并提前修复问题。 |
| Informative title | 信息量高的标题 | 标题能清楚表达任务、技术或问题，而不是空泛命名。 |
| Vibe Writing Skills | 写作技能仓库 | 将写作模板转为可被 AI Agent 使用的 Skills 形式。 |
| Copilot / GPT-assisted writing | AI 辅助写作 | 用 AI 帮助列思路、润色、检查 flow、改英文。 |

---

# 18. 这套模板的整体思路

这套模板不是“英语句式模板”，而是一套论文生产流程模板。它的核心是把论文写作拆成四层：

1. **Story 层**：论文到底解决什么问题，为什么这个问题重要，为什么已有方法解决不好。
2. **Method 层**：你的 pipeline 如何自然地回应这个 technical challenge。
3. **Experiment 层**：用 comparison、ablation、demo 支撑你的 claims。
4. **Presentation 层**：用图、表、排版、标题、摘要提升第一印象。

最重要的写作动作是“倒推”：

- 先确定你真正的 contribution。
- 再确定它解决的 technical challenge。
- 再回头组织 previous methods，让它们自然引出这个 challenge。
- 最后写出 Introduction 和 Abstract。

这和很多人的习惯相反。很多人是从背景开始写，一路写到方法。但这样容易写散。这个模板要求你先知道论文要把读者带到哪里，再设计路线。

---

# 19. 这套模板最值得吸收的重点

## 19.1 Introduction 的重点不是介绍背景，而是制造“解决这个问题的必要性”

好的 Introduction 不是资料综述，而是一个逻辑推导：

1. 这个 task 重要。
2. 现有方法有问题。
3. 这个问题背后有明确 technical reason。
4. 因此需要新的方法。
5. 我们的方法正好解决这个问题。

## 19.2 Method 的重点不是堆细节，而是解释每个模块为什么存在

Method 里每个模块都要回答三件事：

1. 它怎么做。
2. 为什么要这么做。
3. 为什么这样做有优势。

很多论文 Method 难读，是因为只写了“怎么做”，没写“为什么”。

## 19.3 Experiments 的重点是支撑 claim

每个实验都应该对应一个 claim。

- comparison 支撑“我们比已有方法强”。
- ablation 支撑“我们的模块有效”。
- demo 支撑“我们的方法上限高、应用价值强”。

如果 Abstract 和 Introduction 里说了一个 claim，但实验没有支撑，这是高风险问题。

## 19.4 图和表不是装饰，而是审稿体验的一部分

论文第一眼是否高级，很大程度来自：

- teaser 是否直观。
- pipeline 是否突出 novelty。
- 表格是否干净。
- 结果图是否有冲击力。
- 排版是否整齐。

这不等于形式主义。它的本质是降低 reviewer 理解成本。

## 19.5 Limitation 要写，但要避免自杀式暴露

Limitation 应该写成：

- 当前 task setting 的自然边界。
- 当前领域共同面对的开放问题。
- 合理 future work。

不要把会直接击穿论文贡献的技术缺陷主动写成 limitation。

---

# 20. 需要补充的材料

如果后续要把这个文档补全，可以优先补充以下内容：

1. 原笔记中嵌入的图片示例：好看的 teaser、pipeline、table、result figure。
2. 每个递归 URL 下的具体教程全文，例如：
   - 如何梳理论文 Story。
   - 如何列写作思路。
   - 如何整理要做的实验。
   - 如何 Review 论文。