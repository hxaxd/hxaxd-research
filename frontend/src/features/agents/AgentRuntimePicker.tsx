import { useId } from "react";

import type {
  AgentRuntimeDefinition,
  AgentRuntimeId,
} from "../../shared/api/contracts";
import { Icon } from "../../shared/ui/Icon";
import "./agent-runtime.css";

interface Props {
  runtimes: AgentRuntimeDefinition[];
  value: AgentRuntimeId | "";
  onChange: (runtime: AgentRuntimeId) => void;
  codexModel?: string | null;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
}

export function AgentRuntimePicker({
  runtimes,
  value,
  onChange,
  codexModel = null,
  disabled = false,
  loading = false,
  error = null,
}: Props) {
  const name = useId();
  const selected = runtimes.find((runtime) => runtime.id === value) ?? null;

  return (
    <fieldset className="agent-runtime-picker">
      <legend>运行环境</legend>
      {loading && !runtimes.length ? (
        <p className="runtime-picker-state">正在读取可用运行环境…</p>
      ) : error && !runtimes.length ? (
        <p className="runtime-picker-state runtime-picker-state--error" role="alert">{error}</p>
      ) : (
        <div className="runtime-picker-grid">
          {runtimes.map((runtime) => (
            <label
              className={[
                "runtime-option",
                value === runtime.id ? "runtime-option--selected" : "",
                runtime.ready ? "runtime-option--ready" : "runtime-option--unavailable",
              ].filter(Boolean).join(" ")}
              key={runtime.id}
            >
              <input
                checked={value === runtime.id}
                disabled={disabled || !runtime.ready}
                name={name}
                type="radio"
                value={runtime.id}
                onChange={() => onChange(runtime.id)}
              />
              <span className="runtime-option-icon"><Icon name="terminal" size={16} /></span>
              <span className="runtime-option-copy">
                <span><strong>{runtime.label}</strong><em>{runtime.ready ? "已就绪" : "不可用"}</em></span>
                <small>{agentRuntimeModelLabel(runtime, codexModel)}</small>
                <small>{agentRuntimeTransportLabel(runtime.transport)}{runtime.supports_resume ? " · 可恢复运行" : ""}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {selected ? (
        <p className={selected.ready ? "runtime-picker-message" : "runtime-picker-message runtime-picker-message--error"}>
          {selected.message}
        </p>
      ) : null}
    </fieldset>
  );
}

export function resolveAgentRuntimeSelection(
  runtimes: AgentRuntimeDefinition[],
  preferred: AgentRuntimeId,
  current: AgentRuntimeId | "" = "",
) {
  const currentRuntime = runtimes.find((runtime) => runtime.id === current);
  if (currentRuntime?.ready) return currentRuntime.id;
  const preferredRuntime = runtimes.find((runtime) => runtime.id === preferred);
  if (preferredRuntime?.ready) return preferredRuntime.id;
  return runtimes.find((runtime) => runtime.ready)?.id
    ?? preferredRuntime?.id
    ?? currentRuntime?.id
    ?? runtimes[0]?.id
    ?? "";
}

export function agentRuntimeModelLabel(
  runtime: AgentRuntimeDefinition,
  codexModel: string | null = null,
) {
  if (runtime.id === "codex") {
    return codexModel ? `Codex 模型 · ${codexModel}` : "Codex 模型 · 跟随运行时设置";
  }
  return runtime.model === "deepseek-v4-flash"
    ? "固定模型 · DeepSeek V4 Flash"
    : `固定模型 · ${runtime.model || "未报告"}`;
}

export function agentRuntimeLabel(runtime: string) {
  return ({
    codex: "Codex",
    pi: "Pi",
    opencode: "OpenCode",
    "claude-code": "Claude Code",
  } as Record<string, string>)[runtime] ?? runtime;
}

function agentRuntimeTransportLabel(transport: string) {
  return ({
    "app-server": "应用服务协议",
    rpc: "RPC 通道",
    acp: "ACP 通道",
    "stream-json": "流式 JSON",
  } as Record<string, string>)[transport] ?? transport;
}
