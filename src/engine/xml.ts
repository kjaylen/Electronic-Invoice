/**
 * Minimal, deterministic XML writer.
 *
 * The output must be byte-for-byte reproducible because it is signed, so this
 * writer has no options that change formatting at random: attributes are
 * written in insertion order, there is no pretty printing unless asked, and
 * all text is escaped. Characters that XML 1.0 forbids (most control
 * characters) are rejected instead of silently dropped, since they usually mean
 * bad data pasted into a customer name or description.
 */

export type XmlChild = XmlElement | null | undefined | false;

export interface XmlElement {
  readonly name: string;
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly text?: string;
  readonly children: readonly XmlElement[];
}

export class XmlError extends Error {
  override name = 'XmlError';
}

const NAME_PATTERN = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

/** XML 1.0 allows #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]. Lone surrogates fail. */
function hasInvalidXmlChar(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const ok =
      cp === 0x9 ||
      cp === 0xa ||
      cp === 0xd ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    if (!ok) return true;
  }
  return false;
}

function checkText(value: string, where: string): string {
  if (hasInvalidXmlChar(value)) {
    throw new XmlError(`${where} contains a character that is not allowed in XML`);
  }
  return value;
}

function checkName(name: string): string {
  if (!NAME_PATTERN.test(name)) throw new XmlError(`Invalid XML name "${name}"`);
  return name;
}

type Attrs = Record<string, string | undefined>;

function toAttrList(attrs: Attrs | undefined): Array<[string, string]> {
  if (!attrs) return [];
  return Object.entries(attrs)
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => [checkName(k), checkText(v, `Attribute ${k}`)]);
}

/** An element with child elements. Falsy children are skipped, which keeps optional parts readable. */
export function el(name: string, attrs: Attrs | undefined, ...children: XmlChild[]): XmlElement {
  return {
    name: checkName(name),
    attrs: toAttrList(attrs),
    children: children.filter((c): c is XmlElement => Boolean(c)),
  };
}

/** An element holding text. */
export function leaf(name: string, text: string, attrs?: Attrs): XmlElement {
  return { name: checkName(name), attrs: toAttrList(attrs), text: checkText(text, `<${name}>`), children: [] };
}

/** A text element only when the value is present; otherwise nothing. */
export function optLeaf(name: string, text: string | undefined | null, attrs?: Attrs): XmlElement | undefined {
  return text === undefined || text === null || text === '' ? undefined : leaf(name, text, attrs);
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

function write(node: XmlElement, out: string[], indent: string | null, depth: number): void {
  const pad = indent === null ? '' : indent.repeat(depth);
  const nl = indent === null ? '' : '\n';
  const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
  if (node.text !== undefined) {
    out.push(`${pad}<${node.name}${attrs}>${escapeText(node.text)}</${node.name}>${nl}`);
  } else if (node.children.length === 0) {
    out.push(`${pad}<${node.name}${attrs}/>${nl}`);
  } else {
    out.push(`${pad}<${node.name}${attrs}>${nl}`);
    for (const child of node.children) write(child, out, indent, depth + 1);
    out.push(`${pad}</${node.name}>${nl}`);
  }
}

export interface SerializeOptions {
  /** Include <?xml version="1.0" encoding="UTF-8"?>. Default true. */
  declaration?: boolean;
  /** Indent string for human-readable output, e.g. "  ". Default none (compact). */
  indent?: string;
}

export function serialize(root: XmlElement, options: SerializeOptions = {}): string {
  const out: string[] = [];
  if (options.declaration ?? true) {
    out.push(`<?xml version="1.0" encoding="UTF-8"?>${options.indent !== undefined ? '\n' : ''}`);
  }
  write(root, out, options.indent ?? null, 0);
  return out.join('');
}
