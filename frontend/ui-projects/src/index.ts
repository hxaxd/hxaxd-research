/**
 * Project workbench plugin, node half. Pure UI plugin: the empty apply exists
 * so the plugin appears in the host cordis.yml / Loader (load and lifecycle
 * follow the host; the browser half ships via exports["./client"], discovered
 * through the package.json dsh.client declaration).
 *
 * Adapted from @deepseek-ai/dsh-client-ui-workspace
 * (deepseek-harness, MIT License, Copyright (c) 2026 DeepSeek).
 */

/** Host plugin body — no host-side behavior for the project plugin. */
export function apply(): void {}
