/**
 * Build config for @hxaxd/dsh-ui-projects.
 *
 * Adapted from the upstream DSH client-bundle preset
 * (deepseek-harness `packages/client/tsdown.client.ts`, MIT, Copyright (c) 2026 DeepSeek)
 * down to the pieces this package needs:
 *
 * 1. node half — `src/index.ts` → `lib/index.js`, ESM, so the host Loader can
 *    import the plugin's host face;
 * 2. client half — `src/client/index.ts` → `lib/client.js`, CJS wrapped as the
 *    closure factory `window.__ModuleLoader__.load({id, factory})` the browser
 *    module table materializes, with CSS Modules compiled by lightningcss into
 *    style tags injected at factory execution (same attribute contract the
 *    upstream module lifecycle expects);
 * 3. externals — react, cordis, and every module-table row this package's
 *    `dsh.client.inject` names stay imports; the pure helper modules this
 *    source uses (util-values, util-workspace-path,
 *    workspace-controller/default-workspace) inline, exactly like the
 *    upstream purity gate treats them.
 */
import { readFile } from 'node:fs/promises'
import { basename, resolve as resolvePath, dirname, isAbsolute } from 'node:path'
import { defineConfig, type UserConfig, type TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'

const id = '@hxaxd/dsh-ui-projects'

/** Module-table rows the client bundle resolves through the injected require. */
const EXTERNAL_MODULE_IDS = new Set([
  '@deepseek-ai/cordis',
  'react',
  ...[
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-shortcuts',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-slots',
  ].flatMap(name => [name, `${name}/client`]),
])

function isExternal(source: string): boolean {
  if (source.startsWith('react')) return true
  if (EXTERNAL_MODULE_IDS.has(source)) return true
  // Anything else under @deepseek-ai/* is a pure helper this bundle inlines;
  // a deeper subpath of a module-table row (e.g. /types) is type-only.
  return false
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector and the CSS Modules class map. */
function styleInjectionModule(fileId: string, css: string, classMap: Record<string, string>): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ]
  return source.join('\n')
}

/** Compile one physical `x.module.css` into the style-injection module. */
function cssModulesInlinePlugin(): TsdownPlugin {
  return {
    name: 'hxaxd-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined && !isAbsolute(source)
        ? resolvePath(dirname(importer), source)
        : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

const nodeHalf: UserConfig = {
  name: `${id}:node`,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: false,
  external: [/^@deepseek-ai\//, /^react($|\/)/],
}

const clientHalf: UserConfig = {
  name: `${id}:client`,
  entry: ['src/client/index.ts'],
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: false,
  inlineDynamicImports: true,
  treeshake: true,
  external: specifier => isExternal(specifier),
  plugins: [cssModulesInlinePlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([nodeHalf, clientHalf])
