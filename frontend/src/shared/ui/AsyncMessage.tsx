import type { ReactNode } from "react";

import "./async-message.css";

interface AsyncMessageProps {
  kind?: "error" | "empty" | "loading";
  children: ReactNode;
}

export function AsyncMessage({ kind = "empty", children }: AsyncMessageProps) {
  return <div className={`async-message async-message--${kind}`}>{children}</div>;
}
