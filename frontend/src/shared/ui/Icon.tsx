import type { SVGProps } from "react";

export type IconName =
  | "activity"
  | "arrow-left"
  | "arrow-right"
  | "book-open"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "close"
  | "coffee"
  | "download"
  | "file-text"
  | "folder"
  | "home"
  | "inbox"
  | "languages"
  | "library"
  | "maximize"
  | "menu"
  | "moon"
  | "panel-left"
  | "plug"
  | "plus"
  | "search"
  | "settings"
  | "shield"
  | "sparkles"
  | "sun"
  | "terminal"
  | "upload"
  | "external-link"
  | "refresh"
  | "zoom-in"
  | "zoom-out";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, React.ReactNode> = {
  activity: <><path d="M3 12h4l2-7 4 14 2-7h6" /></>,
  "arrow-left": <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>,
  "arrow-right": <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  "book-open": <><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H11v18H4.5A2.5 2.5 0 0 0 2 22z" /><path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H13v18h6.5A2.5 2.5 0 0 1 22 22z" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  close: <><path d="m18 6-12 12" /><path d="m6 6 12 12" /></>,
  coffee: <><path d="M17 8h1a4 4 0 1 1 0 8h-1" /><path d="M3 8h14v6a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z" /><path d="M6 2v2" /><path d="M10 2v2" /><path d="M14 2v2" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  "file-text": <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h6" /></>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9" /><path d="M9 20v-6h6v6" /></>,
  inbox: <><path d="M4 4h16v13H4z" /><path d="M4 13h4l2 3h4l2-3h4" /></>,
  languages: <><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m13 22 4-9 4 9" /><path d="M14.5 19h5" /></>,
  library: <><path d="M4 19.5V4.7A1.7 1.7 0 0 1 5.7 3H8v18H5.5A1.5 1.5 0 0 1 4 19.5Z" /><path d="M8 3h5v18H8" /><path d="m13 4 4.4-1 3.6 16-4.4 1z" /></>,
  maximize: <><path d="M8 3H3v5" /><path d="M16 3h5v5" /><path d="M8 21H3v-5" /><path d="M16 21h5v-5" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  moon: <path d="M20.7 14.3A8.5 8.5 0 0 1 9.7 3.3 8.5 8.5 0 1 0 20.7 14.3Z" />,
  "panel-left": <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  plug: <><path d="m8 12 8-8" /><path d="m14 2 4 4" /><path d="M7 13 4 16l4 4 3-3" /><path d="m10 10 4 4" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
  sparkles: <><path d="m12 3-1.1 3.2a5 5 0 0 1-3.1 3.1L4.5 10.5l3.3 1.2a5 5 0 0 1 3.1 3.1L12 18l1.1-3.2a5 5 0 0 1 3.1-3.1l3.3-1.2-3.3-1.2a5 5 0 0 1-3.1-3.1z" /><path d="m19 17-.4 1.1a2 2 0 0 1-1.2 1.2l-1.1.4 1.1.4a2 2 0 0 1 1.2 1.2L19 22l.4-.7a2 2 0 0 1 1.2-1.2l.9-.4-.9-.4a2 2 0 0 1-1.2-1.2z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.3 17.7-1.4 1.4" /><path d="m19.1 4.9-1.4 1.4" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>,
  upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
  "external-link": <><path d="M14 3h7v7" /><path d="m10 14 11-11" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.7-2.6L20 11" /><path d="m4 13 2.2 4.6A7 7 0 0 0 17.9 15" /></>,
  "zoom-in": <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /><path d="M11 8v6" /><path d="M8 11h6" /></>,
  "zoom-out": <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /><path d="M8 11h6" /></>,
};
