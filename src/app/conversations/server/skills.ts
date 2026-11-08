import 'server-only';

import path from 'node:path';
import { loadSkills } from '@earendil-works/pi-coding-agent';

import type { AppConfig } from '@/app/config.mjs';
import type { SkillCommand } from '../skill-command';

export function workbenchSkillPaths(templateDir: string) {
  return ['settings', 'latex', 'translation', 'conversations']
    .map(feature => path.join(templateDir, 'app', feature, 'skills'));
}

export function listSkillCommands(config: AppConfig, workspaceId: string): SkillCommand[] {
  const { skills } = loadSkills({
    cwd: path.join(config.workspaceDir, workspaceId),
    agentDir: config.piDir,
    skillPaths: workbenchSkillPaths(config.templateDir),
    includeDefaults: false,
  });
  return skills.map(({ name, description }) => ({ name, description }));
}
