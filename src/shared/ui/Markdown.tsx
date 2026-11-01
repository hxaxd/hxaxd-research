'use client';

import './Markdown.css';

import { createCodePlugin } from '@streamdown/code';
import { defaultRemarkPlugins, Streamdown, type StreamdownProps } from 'streamdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

import { remarkTexMath } from './remark-tex-math';

const htmlSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display'], 'metastring'],
    span: [['className', 'math-inline', 'math-display']],
  },
};

const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkMath, remarkTexMath];
// Same sanitize schema as before the Streamdown migration; KaTeX runs after sanitizing.
const rehypePlugins: StreamdownProps['rehypePlugins'] = [rehypeRaw, [rehypeSanitize, htmlSchema], rehypeKatex];
const plugins = { code: createCodePlugin({ themes: ['github-light', 'github-dark'] }) };
const controls = { code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false }, mermaid: false };

/**
 * Markdown for documents and chat. `streaming` finishes unclosed syntax while a
 * reply is still arriving, so partial code fences and tables render cleanly.
 */
export function Markdown({ streaming, ...props }: Pick<StreamdownProps, 'children' | 'components' | 'urlTransform'> & {
  streaming?: boolean;
}) {
  return <Streamdown {...props}
    mode={streaming ? 'streaming' : 'static'}
    isAnimating={!!streaming}
    parseIncompleteMarkdown={!!streaming}
    remarkPlugins={remarkPlugins}
    rehypePlugins={rehypePlugins}
    plugins={plugins}
    controls={controls}
    linkSafety={{ enabled: false }}
    lineNumbers={false}
  />;
}
