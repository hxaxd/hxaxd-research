import type { ReactNode } from "react";

import "./async-message.css";

interface AsyncMessageProps {
  kind?: "error" | "empty" | "loading";
  children: ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
}

export function AsyncMessage({ kind = "empty", children, retryLabel = "重新连接", onRetry }: AsyncMessageProps) {
  return <div className={`async-message async-message--${kind}`} role={kind === "error" ? "alert" : "status"}><div>{children}{onRetry ? <button type="button" onClick={onRetry}>{retryLabel}</button> : null}</div></div>;
}
