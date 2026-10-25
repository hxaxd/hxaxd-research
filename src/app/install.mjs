import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeConfig, readAppConfig } from './config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
initializeConfig(root);
const { templateDir } = readAppConfig(root);
mkdirSync(templateDir, { recursive: true });
cpSync(path.join(root, 'config.default.jsonc'), path.join(templateDir, 'config.default.jsonc'));

for (const entry of [
  'app/settings/skills',
  'app/latex/skills',
  'app/translation/skills',
  'app/translation/prompts',
]) {
  cpSync(path.join(root, 'src', entry), path.join(templateDir, entry), { recursive: true });
}
console.log(`Installed templates in ${templateDir}`);
