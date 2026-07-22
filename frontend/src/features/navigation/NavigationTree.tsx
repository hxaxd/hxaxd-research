import { NavLink } from "react-router-dom";

import { useAppData } from "../../app/AppDataContext";
import { useWorkspaceTheme, type WorkspaceThemePreference } from "../../shared/theme";
import { Icon, type IconName } from "../../shared/ui/Icon";
import "./navigation.css";

interface NavigationTreeProps {
  expanded: boolean;
  onToggle: () => void;
}
const primaryLinks: Array<{ label: string; path: string; icon: IconName }> = [
  { label: "概览", path: "/", icon: "home" },
  { label: "任务与审阅", path: "/tasks", icon: "activity" },
  { label: "导入与同步", path: "/integrations", icon: "plug" },
  { label: "设置", path: "/settings", icon: "settings" },
];

export function NavigationTree({ expanded, onToggle }: NavigationTreeProps) {
  const { projects, connection } = useAppData();
  const { preference, setPreference } = useWorkspaceTheme();
  const themeOptions: Array<{
    value: WorkspaceThemePreference;
    label: string;
    icon: IconName;
  }> = [
    { value: "system", label: "跟随系统", icon: "monitor" },
    { value: "light", label: "亮色", icon: "sun" },
    { value: "dark", label: "暗色", icon: "moon" },
  ];
  const currentTheme = themeOptions.find((option) => option.value === preference)!;
  const cycleTheme = () => {
    const currentIndex = themeOptions.findIndex((option) => option.value === preference);
    setPreference(themeOptions[(currentIndex + 1) % themeOptions.length]!.value);
  };
  return (
    <nav
      className={expanded ? "navigation-tree" : "navigation-tree navigation-tree--collapsed"}
      aria-label="文献索引工作台"
    >
      <div className="sidebar-brand">
        <NavLink className="brand-link" end to="/" title="文献索引工作台">
          <span className="brand-mark"><Icon name="library" size={21} /></span>
          <span className="brand-copy"><small>HXAXD RESEARCH</small><strong>文献工作台</strong></span>
        </NavLink>
        <button className="sidebar-toggle" type="button" onClick={onToggle} aria-label={expanded ? "收起导航" : "展开导航"}>
          <Icon name={expanded ? "chevron-left" : "panel-left"} size={18} />
        </button>
      </div>

      <div className="primary-navigation">
        {primaryLinks.map((item) => (
          <NavLink className="primary-nav-link" end={item.path === "/"} key={item.path} to={item.path} title={item.label}>
            <Icon name={item.icon} size={18} /><span>{item.label}</span>
          </NavLink>
        ))}
      </div>

      <div className="sidebar-section-heading">
        <span>项目</span>
        <span className="section-count">{projects.length}</span>
        <NavLink className="project-create-link" to="/?newProject=1" title="创建项目" aria-label="创建项目">
          <Icon name="plus" size={14} />
        </NavLink>
      </div>
      <div className="navigation-scroll">
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <NavLink className="project-link" to={`/projects/${project.id}`} title={project.name}>
                <Icon name="folder" size={17} />
                <span>{project.name}</span>
                {project.candidate_count ? <em>{project.candidate_count}</em> : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>

      {expanded ? (
        <div className="theme-switcher" role="group" aria-label="工作台外观">
          {themeOptions.map((option) => (
            <button
              aria-pressed={preference === option.value}
              className={preference === option.value ? "active" : ""}
              key={option.value}
              title={option.label}
              type="button"
              onClick={() => setPreference(option.value)}
            >
              <Icon name={option.icon} size={16} />
              <span>{option.label.replace("跟随", "")}</span>
            </button>
          ))}
        </div>
      ) : (
        <button
          aria-label={`外观：${currentTheme.label}，点击切换`}
          className="theme-cycle-button"
          title={`外观：${currentTheme.label}`}
          type="button"
          onClick={cycleTheme}
        >
          <Icon name={currentTheme.icon} size={17} />
        </button>
      )}

      <div className={`sidebar-footer sidebar-footer--${connection}`}>
        <span className="service-indicator" /><span>{connection === "connected" ? "服务已连接" : connection === "connecting" ? "正在连接" : "服务已断开"}</span>
      </div>
    </nav>
  );
}
