import './Markdown.css';

import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

import { remarkTexMath } from './remark-tex-math';

export function Markdown(props: Pick<Options, 'children' | 'components' | 'urlTransform'>) {
  return <ReactMarkdown {...props}
    remarkPlugins={[remarkGfm, remarkMath, remarkTexMath]}
    rehypePlugins={[rehypeKatex]}
  />;
}
