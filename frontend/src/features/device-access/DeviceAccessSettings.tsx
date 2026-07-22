import { useState } from "react";

import { api } from "../../shared/api/client";
import type { PairingTicket } from "../../shared/api/contracts";
import { useApiResource } from "../../shared/api/useApiResource";
import { Icon } from "../../shared/ui/Icon";
import "./device-access.css";

export function DeviceAccessSettings() {
  const access = useApiResource(() => api.deviceAccessStatus(), []);
  const sessions = useApiResource(
    () => access.data?.authenticated ? api.deviceSessions() : Promise.resolve([]),
    [access.data?.authenticated],
  );
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function createPairing() {
    setBusy("pairing");
    setFeedback(null);
    try {
      setTicket(await api.createDevicePairing({ label: "平板设备", ttl_seconds: 600 }));
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "无法生成配对码");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(sessionId: string) {
    setBusy(sessionId);
    setFeedback(null);
    try {
      const revoked = await api.revokeDeviceSession(sessionId);
      sessions.setData(
        (sessions.data ?? []).map((session) => session.id === revoked.id ? revoked : session),
      );
      setFeedback(revoked.current ? "当前设备会话已撤销，请重新配对" : "设备会话已撤销");
      if (revoked.current) window.location.reload();
    } catch (reason) {
      setFeedback(reason instanceof Error ? reason.message : "撤销设备失败");
    } finally {
      setBusy(null);
    }
  }

  const activeSessions = (sessions.data ?? []).filter((session) => !session.revoked_at);
  return <section className="settings-operation-section device-access-settings">
    <header><div><span className="eyebrow">平板与触屏设备</span><h2>局域网与受信任设备</h2><p>局域网监听默认关闭；短期配对码只在本机显示，会话可以单独撤销。</p></div><span className={access.data?.lan_enabled ? "device-access-state device-access-state--ready" : "device-access-state"}>{access.data?.lan_enabled ? "已显式启用" : "仅限本机"}</span></header>
    <div className="device-access-body">
      {!access.data?.lan_enabled ? <div className="device-access-explainer"><Icon name="shield" size={22} /><div><strong>当前没有向局域网开放</strong><p>需要平板访问时，通过后端启动命令显式开启局域网模式；普通启动始终只监听本机。</p></div></div> : null}
      {access.data?.lan_enabled && !access.data.cookie_secure ? <div className="device-access-warning"><Icon name="shield" size={18} /><p>当前使用未加密调试模式，浏览器不会获得安全 Cookie，也不能可靠安装 PWA。请改用受信任的 HTTPS 证书启动。</p></div> : null}
      {access.data?.lan_enabled && access.data.local_request ? <div className="pairing-ticket-area"><div><strong>添加一台平板或触屏设备</strong><p>配对码有效 10 分钟，成功使用后立即失效。正式使用要求电脑与平板都信任 HTTPS 证书。</p></div><button className="primary-toolbar-button" disabled={busy === "pairing"} type="button" onClick={() => void createPairing()}><Icon name="plus" size={15} />{busy === "pairing" ? "生成中…" : "生成配对码"}</button>{ticket ? <div className="pairing-ticket"><span>一次性配对码</span><strong>{ticket.code}</strong><small>有效至 {new Date(ticket.expires_at).toLocaleTimeString()}</small></div> : null}</div> : null}
      <div className="device-session-section"><header><div><strong>设备会话</strong><p>{activeSessions.length} 台设备仍可访问工作台</p></div><button className="toolbar-button" type="button" onClick={() => void sessions.reload()}><Icon name="refresh" size={14} />刷新</button></header>{sessions.loading ? <p className="settings-empty">正在读取设备会话…</p> : activeSessions.length ? <div className="device-session-list">{activeSessions.map((session) => <article key={session.id}><span className="device-session-icon"><Icon name="shield" size={17} /></span><div><strong>{session.label}{session.current ? <em>当前设备</em> : null}</strong><small>最近访问 {new Date(session.last_seen_at).toLocaleString()} · 到期 {new Date(session.expires_at).toLocaleDateString()}</small></div><button className="danger-quiet-button" disabled={busy === session.id} type="button" onClick={() => void revoke(session.id)}><Icon name="trash" size={14} />撤销</button></article>)}</div> : <p className="settings-empty">还没有已配对的远程设备。</p>}</div>
      {access.error || sessions.error ? <div className="settings-inline-error"><p>{access.error || sessions.error}</p><button className="toolbar-button" type="button" onClick={() => void (access.error ? access.retry() : sessions.retry())}><Icon name="refresh" size={14} />重新读取</button></div> : null}
      {feedback ? <p className="settings-feedback">{feedback}</p> : null}
    </div>
  </section>;
}
