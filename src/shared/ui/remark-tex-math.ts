import type {} from 'remark-parse';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Construct, Extension, State } from 'micromark-util-types';
import type { Processor } from 'unified';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    texMath: 'texMath'; texMathMarker: 'texMathMarker';
    texMathData: 'texMathData'; texMathLineEnding: 'texMathLineEnding';
  }
}

const texMath: Construct = {
  name: 'texMath',
  tokenize(effects, ok, nok) {
    let closing: number;
    const start: State = code => {
      effects.enter('texMath');
      effects.enter('texMathMarker');
      effects.consume(code);
      return opening;
    };
    const opening: State = code => {
      if (code !== 40 && code !== 91) return nok(code);
      closing = code === 40 ? 41 : 93;
      effects.consume(code);
      effects.exit('texMathMarker');
      return content;
    };
    const content: State = code => {
      if (code === null) return nok(code);
      // Micromark uses negative codes for CR, LF and CRLF.
      if (code === -5 || code === -4 || code === -3) {
        effects.enter('texMathLineEnding');
        effects.consume(code);
        effects.exit('texMathLineEnding');
        return content;
      }
      effects.enter('texMathData');
      return data(code);
    };
    const data: State = code => {
      if (code === null) return nok(code);
      if (code === -5 || code === -4 || code === -3) {
        effects.exit('texMathData');
        return content(code);
      }
      effects.consume(code);
      return code === 92 ? afterSlash : data;
    };
    const afterSlash: State = code => {
      if (code !== closing && code !== 92) return data(code);
      effects.consume(code);
      if (code !== closing) return data;
      effects.exit('texMathData');
      effects.exit('texMath');
      return ok;
    };
    return start;
  },
};

// Parse TeX delimiters before Markdown consumes backslashes, emphasis or brackets.
export function remarkTexMath(this: Processor) {
  const syntax: Extension = { text: { 92: texMath } };
  const nodes: FromMarkdownExtension = { exit: {
    texMath(token) {
      const source = this.sliceSerialize(token);
      const value = source.slice(2, -2);
      this.enter({
        type: 'inlineMath', value,
        data: {
          hName: 'span',
          hProperties: { className: [source[1] === '[' ? 'math-display' : 'math-inline'] },
          hChildren: [{ type: 'text', value }],
        },
      }, token);
      this.exit(token);
    },
  } };
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(nodes);
}
