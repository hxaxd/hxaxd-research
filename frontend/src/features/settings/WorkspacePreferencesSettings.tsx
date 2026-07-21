import { useEffect, useState } from "react";

import { api } from "../../shared/api/client";
import type {
  AgentPreferences,
  BilingualPreferences,
  PdfPreferences,
  ReaderPreferences,
  TaskPreferences,
  TranslationPreferences,
  UserPreferences,
} from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { Icon } from "../../shared/ui/Icon";
import "./preferences.css";

type Section = "reader" | "bilingual" | "pdf" | "translation" | "agent" | "tasks";

const sections: Array<{ id: Section; label: string }> = [
  { id: "reader", label: "阅读" },
  { id: "bilingual", label: "双语" },
  { id: "pdf", label: "PDF" },
  { id: "translation", label: "翻译" },
  { id: "agent", label: "智能体" },
  { id: "tasks", label: "任务" },
];

const capabilityLabels: Record<AgentPreferences["enabled_capabilities"][number], string> = {
  catalog_read: "读取文献索引",
  candidate_propose: "提出候选",
  metadata_propose: "提出元数据修改",
  resource_propose: "提出资源获取",
  zotero_conflict_propose: "提出 Zotero 冲突方案",
  web_search: "检索网页",
};

export function WorkspacePreferencesSettings() {
  const resource = useApiResource(() => api.userPreferences(), []);
  const [draft, setDraft] = useState<UserPreferences | null>(null);
  const [section, setSection] = useState<Section>("reader");
  const [glossaryText, setGlossaryText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!resource.data) return;
    setDraft(resource.data);
    setGlossaryText(
      resource.data.translation.glossary
        .map((entry) => `${entry.source_term} = ${entry.translated_term}`)
        .join("\n"),
    );
  }, [resource.data]);

  function patch<K extends keyof Pick<UserPreferences, Section>>(
    key: K,
    value: UserPreferences[K],
  ) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setFeedback(null);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setFeedback(null);
    try {
      let notificationPermission: NotificationPermission | "unsupported" | null = null;
      if (draft.tasks.notify_on_success || draft.tasks.notify_on_failure) {
        notificationPermission = "Notification" in window
          ? Notification.permission === "default"
            ? await Notification.requestPermission()
            : Notification.permission
          : "unsupported";
      }
      const saved = await api.updateUserPreferences({
        expected_revision: draft.revision,
        reader: draft.reader,
        bilingual: draft.bilingual,
        pdf: draft.pdf,
        translation: {
          ...draft.translation,
          glossary: parseGlossary(glossaryText),
        },
        agent: draft.agent,
        tasks: draft.tasks,
      });
      resource.setData(saved);
      setDraft(saved);
      setFeedback(
        notificationPermission === "denied"
          ? "设置已保存；系统通知被浏览器拒绝，应用内仍会显示任务提醒。"
          : notificationPermission === "unsupported"
          ? "设置已保存；当前浏览器不支持系统通知，应用内仍会显示任务提醒。"
          : "设置已保存，并将用于之后的阅读、翻译与智能体任务。",
      );
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "无法保存设置");
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-operation-section preferences-settings">
    <header><div><span className="eyebrow">WORKSPACE PREFERENCES</span><h2>工作台偏好</h2><p>可迁移偏好统一保存在后端；抽屉开合等瞬时界面状态只留在当前设备。</p></div><span className="preferences-revision">修订 {draft?.revision ?? 0}</span></header>
    {resource.error && !draft ? <div className="settings-inline-error"><p>{resource.error}</p><button className="toolbar-button" type="button" onClick={() => void resource.retry()}><Icon name="refresh" size={14} />重新读取</button></div> : resource.loading || !draft ? <p className="settings-empty">正在读取设置…</p> : <>
      <nav aria-label="设置分区" className="preferences-tabs">
        {sections.map((entry) => <button aria-pressed={section === entry.id} className={section === entry.id ? "active" : ""} key={entry.id} type="button" onClick={() => setSection(entry.id)}>{entry.label}</button>)}
      </nav>
      <div className="preferences-panel">
        {section === "reader" ? <ReaderFields value={draft.reader} onChange={(value) => patch("reader", value)} /> : null}
        {section === "bilingual" ? <BilingualFields value={draft.bilingual} onChange={(value) => patch("bilingual", value)} /> : null}
        {section === "pdf" ? <PdfFields value={draft.pdf} onChange={(value) => patch("pdf", value)} /> : null}
        {section === "translation" ? <TranslationFields value={draft.translation} glossaryText={glossaryText} onGlossaryText={setGlossaryText} onChange={(value) => patch("translation", value)} /> : null}
        {section === "agent" ? <AgentFields value={draft.agent} onChange={(value) => patch("agent", value)} /> : null}
        {section === "tasks" ? <TaskFields value={draft.tasks} onChange={(value) => patch("tasks", value)} /> : null}
      </div>
      <footer className="preferences-actions"><p>{feedback || "保存后，新任务使用最新配置；正在运行的任务继续使用创建时的配置快照。"}</p><button className="primary-button" disabled={busy} type="button" onClick={() => void save()}><Icon name="check" size={15} />{busy ? "保存中…" : "保存全部设置"}</button></footer>
    </>}
  </section>;
}

function ReaderFields({ value, onChange }: { value: ReaderPreferences; onChange: (value: ReaderPreferences) => void }) {
  return <fieldset><legend>阅读排版与默认入口</legend><div className="preferences-fields">
    <Select label="目标语言" value={value.target_language} onChange={(target_language) => onChange({ ...value, target_language })} options={[["zh-CN","简体中文"],["zh-TW","繁体中文"],["en","English"]]} />
    <Select label="默认语言视图" value={value.default_mode} onChange={(default_mode) => onChange({ ...value, default_mode: default_mode as ReaderPreferences["default_mode"] })} options={[["source","原文"],["bilingual","双语"],["translation","译文"]]} />
    <Select label="默认面板" value={value.default_panel} onChange={(default_panel) => onChange({ ...value, default_panel: default_panel as ReaderPreferences["default_panel"] })} options={[['structured','结构阅读'],['pdf','PDF 版面'],['split','分屏']]} />
    <Select label="字体" value={value.font_family} onChange={(font_family) => onChange({ ...value, font_family: font_family as ReaderPreferences["font_family"] })} options={[['serif','衬线'],['sans','无衬线'],['system','系统字体']]} />
    <Select label="字号" value={value.font_size} onChange={(font_size) => onChange({ ...value, font_size: font_size as ReaderPreferences["font_size"] })} options={[['small','紧凑'],['medium','标准'],['large','大字']]} />
    <Select label="行距" value={value.line_height} onChange={(line_height) => onChange({ ...value, line_height: line_height as ReaderPreferences["line_height"] })} options={[['compact','紧凑'],['standard','标准'],['relaxed','舒展']]} />
    <Select label="内容宽度" value={value.measure} onChange={(measure) => onChange({ ...value, measure: measure as ReaderPreferences["measure"] })} options={[['focused','专注'],['balanced','均衡'],['wide','宽屏']]} />
    <Select label="块间距" value={value.density} onChange={(density) => onChange({ ...value, density: density as ReaderPreferences["density"] })} options={[["compact","紧密"],["comfortable","舒展"]]} />
    <Select label="阅读流" value={value.flow} onChange={(flow) => onChange({ ...value, flow: flow as ReaderPreferences["flow"] })} options={[['continuous','连续滚动'],['paged','分页吸附']]} />
    <Select label="分栏" value={value.columns} onChange={(columns) => onChange({ ...value, columns: columns as ReaderPreferences["columns"] })} options={[['auto','自动'],['single','单栏'],['double','双栏']]} />
    <Select label="阅读配色" value={value.theme} onChange={(theme) => onChange({ ...value, theme: theme as ReaderPreferences["theme"] })} options={[['dark','深色'],['light','浅色'],['sepia','柔和棕']]} />
  </div><ToggleGrid items={[
    ["显示目录", value.show_outline, (checked) => onChange({ ...value, show_outline: checked })],
    ["恢复阅读位置", value.restore_position, (checked) => onChange({ ...value, restore_position: checked })],
    ["大触控目标", value.large_touch_targets, (checked) => onChange({ ...value, large_touch_targets: checked })],
    ["减少动态效果", value.reduce_motion, (checked) => onChange({ ...value, reduce_motion: checked })],
  ]} /></fieldset>;
}

function BilingualFields({ value, onChange }: { value: BilingualPreferences; onChange: (value: BilingualPreferences) => void }) {
  return <fieldset><legend>原译文协作方式</legend><div className="preferences-fields"><Select label="双语布局" value={value.layout} onChange={(layout) => onChange({ ...value, layout: layout as BilingualPreferences["layout"] })} options={[['side_by_side','左右并排'],['stacked','上下排列']]} /></div><ToggleGrid items={[
    ["高亮术语", value.highlight_terms, (checked) => onChange({ ...value, highlight_terms: checked })],
    ["段落联动", value.synchronize_blocks, (checked) => onChange({ ...value, synchronize_blocks: checked })],
  ]} /></fieldset>;
}

function PdfFields({ value, onChange }: { value: PdfPreferences; onChange: (value: PdfPreferences) => void }) {
  return <fieldset><legend>PDF 显示与操作</legend><div className="preferences-fields">
    <Select label="色彩模式" value={value.color_mode} onChange={(color_mode) => onChange({ ...value, color_mode: color_mode as PdfPreferences["color_mode"] })} options={[['original','原始'],['dark','深色'],['sepia','柔和棕']]} />
    <Select label="默认缩放" value={value.default_zoom} onChange={(default_zoom) => onChange({ ...value, default_zoom: default_zoom as PdfPreferences["default_zoom"] })} options={[['auto','自动'],['page_width','适合宽度'],['page_fit','适合整页']]} />
    <Select label="工具栏密度" value={value.toolbar_density} onChange={(toolbar_density) => onChange({ ...value, toolbar_density: toolbar_density as PdfPreferences["toolbar_density"] })} options={[['compact','紧凑'],['comfortable','舒展']]} />
  </div><ToggleGrid items={[["恢复 PDF 位置", value.restore_position, (checked) => onChange({ ...value, restore_position: checked })]]} /></fieldset>;
}

function TranslationFields({ value, glossaryText, onGlossaryText, onChange }: { value: TranslationPreferences; glossaryText: string; onGlossaryText: (value: string) => void; onChange: (value: TranslationPreferences) => void }) {
  return <fieldset><legend>整篇翻译策略</legend><div className="preferences-fields">
    <TextField label="提供者" value={value.provider} onChange={(provider) => onChange({ ...value, provider })} />
    <TextField label="模型" value={value.model} onChange={(model) => onChange({ ...value, model })} />
    <Select label="翻译风格" value={value.style} onChange={(style) => onChange({ ...value, style: style as TranslationPreferences["style"] })} options={[['faithful_academic','忠实学术'],['natural_academic','自然学术'],['concise','克制简洁']]} />
    <Select label="批次策略" value={value.batching} onChange={(batching) => onChange({ ...value, batching: batching as TranslationPreferences["batching"] })} options={[['whole_with_fallback','整篇优先，章节降级'],['whole_only','仅整篇'],['chapter','始终按章节']]} />
    <Select label="重新翻译范围" value={value.retranslate_scope} onChange={(retranslate_scope) => onChange({ ...value, retranslate_scope: retranslate_scope as TranslationPreferences["retranslate_scope"] })} options={[['changed','仅变化块'],['document','整篇']]} />
    <label className="preferences-field preferences-field--wide"><span>术语表</span><textarea aria-label="术语表" placeholder="source term = 统一译名" value={glossaryText} onChange={(event) => onGlossaryText(event.target.value)} /><small>每行一项，使用等号分隔；翻译任务会把它作为受控全局上下文。</small></label>
  </div></fieldset>;
}

function AgentFields({ value, onChange }: { value: AgentPreferences; onChange: (value: AgentPreferences) => void }) {
  function toggle(capability: AgentPreferences["enabled_capabilities"][number], checked: boolean) {
    onChange({ ...value, enabled_capabilities: checked ? [...value.enabled_capabilities, capability] : value.enabled_capabilities.filter((item) => item !== capability) });
  }
  return <fieldset><legend>智能体运行默认值与能力边界</legend><div className="preferences-fields">
    <TextField label="默认模型（留空跟随运行时）" value={value.model ?? ""} onChange={(model) => onChange({ ...value, model: model.trim() || null })} />
    <Select label="推理强度" value={value.reasoning_effort} onChange={(reasoning_effort) => onChange({ ...value, reasoning_effort: reasoning_effort as AgentPreferences["reasoning_effort"] })} options={[['low','低'],['medium','中'],['high','高'],['xhigh','很高']]} />
    <Select label="上下文摘要" value={value.context_summary} onChange={(context_summary) => onChange({ ...value, context_summary: context_summary as AgentPreferences["context_summary"] })} options={[['compact','紧凑'],['balanced','均衡'],['detailed','详细']]} />
  </div><div className="preferences-capabilities">{Object.entries(capabilityLabels).map(([id, label]) => <label key={id}><input checked={value.enabled_capabilities.includes(id as AgentPreferences["enabled_capabilities"][number])} type="checkbox" onChange={(event) => toggle(id as AgentPreferences["enabled_capabilities"][number], event.target.checked)} />{label}</label>)}</div><p className="preferences-help">任务自身的最小作用域仍由后端策略决定；关闭能力只会进一步收窄，不会扩大权限。</p></fieldset>;
}

function TaskFields({ value, onChange }: { value: TaskPreferences; onChange: (value: TaskPreferences) => void }) {
  return <fieldset><legend>持久任务反馈与调度</legend><div className="preferences-fields"><label className="preferences-field"><span>并发上限</span><input aria-label="并发上限" max={8} min={1} type="number" value={value.max_concurrent_jobs} onChange={(event) => onChange({ ...value, max_concurrent_jobs: Number(event.target.value) })} /></label></div><ToggleGrid items={[
    ["完成时通知", value.notify_on_success, (checked) => onChange({ ...value, notify_on_success: checked })],
    ["失败时通知", value.notify_on_failure, (checked) => onChange({ ...value, notify_on_failure: checked })],
    ["自动打开结果", value.auto_open_result, (checked) => onChange({ ...value, auto_open_result: checked })],
  ]} /></fieldset>;
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return <label className="preferences-field"><span>{label}</span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="preferences-field"><span>{label}</span><input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ToggleGrid({ items }: { items: Array<[string, boolean, (value: boolean) => void]> }) {
  return <div className="preferences-toggles">{items.map(([label, checked, onChange]) => <label key={label}><input checked={checked} type="checkbox" onChange={(event) => onChange(event.target.checked)} />{label}</label>)}</div>;
}

function parseGlossary(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1 || separator === line.length - 1) throw new Error(`术语表格式错误：${line}`);
    return { source_term: line.slice(0, separator).trim(), translated_term: line.slice(separator + 1).trim() };
  });
}
