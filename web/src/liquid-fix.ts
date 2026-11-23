/**
 * Liquid for the template editor, with whitespace-trimming end tags understood.
 *
 * @codemirror/lang-liquid looks for `{% endcomment %}` and `{% endraw %}` without allowing the dash
 * of `{%- endcomment -%}`, so after such a comment the whole rest of the file was coloured as a
 * comment. Its comment and raw tokenizers are replaced here with ones that allow the dash. The
 * parser's token ids are checked first: if a new version of the package changes them, the editor
 * keeps the package's own behaviour instead of breaking.
 */

import { liquid, type LiquidCompletionConfig } from '@codemirror/lang-liquid';
import { LanguageSupport, type LRLanguage } from '@codemirror/language';
import { ExternalTokenizer, type LRParser } from '@lezer/lr';

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 32 || c === 10 || c === 9 || c === 13;

/** Text up to `{% end<tag> %}` (or `{%- end<tag>`), then the end tag's opening brace as its own token. */
function rawTokenizer(endTag: string, textToken: number, tagStartToken: number) {
  return new ExternalTokenizer((input) => {
    const start = input.pos;
    for (;;) {
      const next = input.next;
      if (next === 123 /* { */ && input.peek(1) === 37 /* % */) {
        let scan = 2;
        let size = 2;
        if (input.peek(scan) === 45 /* - */) size = ++scan;
        while (isSpace(input.peek(scan))) scan++;
        let word = '';
        for (; isLetter(input.peek(scan)); scan++) word += String.fromCharCode(input.peek(scan));
        if (word === endTag) {
          if (input.pos > start) break;
          input.acceptToken(tagStartToken, size);
          return;
        }
      } else if (next < 0) {
        break;
      }
      input.advance();
      if (next === 10) break;
    }
    if (input.pos > start) input.acceptToken(textToken);
  });
}

// Token ids in lang-liquid 6.x's generated parser (its tokenizers are [base, raw, comment, …]).
const END_RAW = 4;
const END_COMMENT = 5;
const RAW_TEXT = 184;
const COMMENT_TEXT = 185;

/** Does this language find the end of a trimmed comment and of a plain one? */
function seesCommentEnds(language: LRLanguage): boolean {
  return ['{%- comment -%}x{%- endcomment -%}<p>{{ y }}</p>', '{% comment %}x{% endcomment %}<p>{{ y }}</p>'].every((src) => {
    const tree = language.parser.parse(src);
    return tree.resolveInner(src.indexOf('x'), 1).name === 'CommentText' && tree.resolveInner(src.indexOf('y'), 1).name === 'VariableName';
  });
}

export function liquidSupport(config: LiquidCompletionConfig & { base?: LanguageSupport } = {}): LanguageSupport {
  const support = liquid(config);
  try {
    const language = support.language as LRLanguage;
    const tokenizers = (language.parser as LRParser & { tokenizers?: readonly unknown[] }).tokenizers;
    if (!(tokenizers?.[1] instanceof ExternalTokenizer) || !(tokenizers[2] instanceof ExternalTokenizer)) return support;
    const fixed = language.configure({
      tokenizers: [
        { from: tokenizers[1], to: rawTokenizer('endraw', RAW_TEXT, END_RAW) },
        { from: tokenizers[2], to: rawTokenizer('endcomment', COMMENT_TEXT, END_COMMENT) },
      ],
    });
    // A later version of the package with other ids would fail this: keep its own behaviour then.
    return seesCommentEnds(fixed) ? new LanguageSupport(fixed, support.support) : support;
  } catch {
    return support;
  }
}
