import { useState, type ReactNode } from "react";

import { api } from "../../shared/api/client";
import { useApiResource } from "../../shared/api/useApiResource";
import { Icon } from "../../shared/ui/Icon";
import "./device-access.css";

export function DeviceAccessGate({ children }: { children: ReactNode }) {
  const access = useApiResource(() => api.deviceAccessStatus(), []);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(() => deviceLabel());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pair() {
    setSubmitting(true);
    setError(null);
    try {
      const paired = await api.pairDevice({ code, label });
      access.setData(paired.status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设备配对失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (access.loading) {
    return <main className="pairing-gate pairing-gate--loading"><Icon name="shield" size={28} /><p>正在确认设备访问权限…</p></main>;
  }
  if (access.error || !access.data) {
    return <main className="pairing-gate"><section><span className="pairing-gate__icon pairing-gate__icon--error"><Icon name="shield" size={28} /></span><span className="eyebrow">CONNECTION BLOCKED</span><h1>无法安全连接工作台</h1><p>{access.error ?? "访问状态不可用"}</p><button className="primary-button" type="button" onClick={() => void access.reload()}><Icon name="refresh" size={16} />重新连接</button></section></main>;
  }
  if (access.data.authenticated || access.data.local_request) return children;
  return <main className="pairing-gate">
    <form className="pairing-card" onSubmit={(event) => { event.preventDefault(); void pair(); }}>
      <span className="pairing-gate__icon"><Icon name="shield" size={28} /></span>
      <span className="eyebrow">TRUSTED DEVICE</span>
      <h1>将这台设备与工作台配对</h1>
      <p>请在运行后端的电脑上打开“设置 → 局域网与设备”，生成一次性配对码。配对成功后，这台设备会获得可随时撤销的浏览器会话。</p>
      <label>设备名称<input autoComplete="name" maxLength={120} required value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>一次性配对码<input autoCapitalize="characters" autoComplete="one-time-code" inputMode="text" maxLength={20} placeholder="ABCD-EFGH" required value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} /></label>
      {error ? <p className="pairing-error">{error}</p> : null}
      <button className="primary-button" disabled={submitting || code.length < 8 || !label.trim()} type="submit"><Icon name={submitting ? "activity" : "plug"} size={17} />{submitting ? "正在建立安全会话…" : "配对并进入工作台"}</button>
      <small>配对码只使用一次，不会写入网址、浏览器存储或任务日志。</small>
    </form>
  </main>;
}

function deviceLabel(): string {
  const platform = navigator.platform || "平板设备";
  return `${platform} 浏览器`;
}
