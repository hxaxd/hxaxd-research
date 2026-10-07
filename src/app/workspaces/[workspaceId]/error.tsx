'use client';
export default function ErrorPage({ reset }: { reset: () => void }) { return <div className="loading-screen"><h2>工作区暂时无法打开</h2><p>请检查本地服务日志与资料目录。</p><button className="button primary" onClick={reset}>重新打开</button></div>; }
