import './Markdown.css';

import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

import { remarkTexMath } from './remark-tex-math';

const htmlSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    span: [['className', 'math-inline', 'math-display']],
  },
};

export function Markdown(props: Pick<Options, 'children' | 'components' | 'urlTransform'>) {
  return <ReactMarkdown {...props}
    remarkPlugins={[remarkGfm, remarkMath, remarkTexMath]}
    rehypePlugins={[rehypeRaw, [rehypeSanitize, htmlSchema], rehypeKatex]}
  />;
}
