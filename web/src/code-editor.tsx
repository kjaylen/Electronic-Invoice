/**
 * The code editor for templates: CodeMirror 6 with Liquid on HTML (or CSS), completion for the
 * template's own variables, Liquid's tags and filters (ours too: money, amount, pluralize, bts),
 * problems from the server marked on their lines, search, and Ctrl/⌘+S to save.
 */

import { autocompletion, closeBrackets, closeBracketsKeymap, type Completion, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { liquid } from '@codemirror/lang-liquid';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
  crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface CodeProblem { message: string; line?: number }
export interface CodeVariable { name: string; description: string }

export interface CodeEditorHandle {
  /** Insert text at the cursor (replacing the selection) and focus the editor. */
  insert(text: string): void;
  /** Put the cursor on a line and scroll it into view. */
  goToLine(line: number): void;
  focus(): void;
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: '#7c2fa8', fontWeight: '560' },
  { tag: [t.tagName], color: '#1d4ed8' },
  { tag: [t.angleBracket], color: '#6b7280' },
  { tag: [t.attributeName, t.propertyName], color: '#a2520a' },
  { tag: [t.attributeValue, t.string, t.special(t.string)], color: '#0f7a43' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b42318' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: '#8a90a0', fontStyle: 'italic' },
  { tag: [t.variableName], color: '#0f1117' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#0e7490' },
  { tag: [t.brace, t.bracket, t.paren, t.punctuation, t.separator], color: '#646b7b' },
  { tag: [t.className], color: '#a2520a' },
  { tag: [t.unit], color: '#b42318' },
  { tag: [t.processingInstruction, t.meta], color: '#7c2fa8' },
  { tag: t.invalid, color: '#b42318', textDecoration: 'underline wavy' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--sheet)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace", lineHeight: '1.65', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '12px 0 40vh', caretColor: 'var(--brand)' },
  '.cm-line': { padding: '0 16px 0 10px' },
  '.cm-gutters': { backgroundColor: 'var(--sheet-2)', color: '#9aa0ad', borderRight: '1px solid var(--hairline)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 14px', minWidth: '34px' },
  '.cm-activeLine': { backgroundColor: 'rgba(109, 45, 147, 0.045)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(109, 45, 147, 0.08)', color: 'var(--brand-ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--brand)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(109, 45, 147, 0.16) !important' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(123, 245, 131, 0.28)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(109, 45, 147, 0.14)', outline: '1px solid rgba(109, 45, 147, 0.35)', borderRadius: '2px' },
  '.cm-foldGutter .cm-gutterElement': { color: '#b4b9c4', padding: '0 4px', cursor: 'pointer' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--brand-soft)', border: '1px solid var(--brand-line)', color: 'var(--brand-ink)', borderRadius: '4px', padding: '0 6px' },
  '.cm-tooltip': { border: '1px solid var(--hairline)', borderRadius: '10px', backgroundColor: 'var(--sheet)', boxShadow: 'var(--shadow-lift)', overflow: 'hidden' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--sans)', maxHeight: '18em', padding: '4px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px', borderRadius: '6px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--brand)', color: '#fff' },
  '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': { color: 'rgba(255,255,255,0.8)' },
  '.cm-completionLabel': { fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace", fontSize: '12.5px' },
  '.cm-completionDetail': { marginLeft: '10px', fontStyle: 'normal', color: 'var(--muted)', fontSize: '12px' },
  '.cm-completionInfo': { padding: '8px 10px', maxWidth: '320px', fontFamily: 'var(--sans)', fontSize: '12.5px' },
  '.cm-tooltip-lint': { padding: '2px' },
  '.cm-diagnostic': { padding: '6px 10px', fontFamily: 'var(--sans)', fontSize: '12.5px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--coral)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--coral)', textUnderlineOffset: '3px' },
  '.cm-gutter-lint': { width: '14px' },
  '.cm-lint-marker': { width: '10px', height: '10px', marginTop: '5px' },
  '.cm-panels': { backgroundColor: 'var(--sheet-2)', color: 'var(--ink)', borderColor: 'var(--hairline)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--hairline)' },
  '.cm-search': { padding: '8px 10px', fontFamily: 'var(--sans)', fontSize: '13px', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
  '.cm-search input, .cm-search button, .cm-search label': { margin: '0', fontSize: '13px' },
  '.cm-search .cm-textfield': { padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--hairline-strong)', backgroundColor: 'var(--sheet)', minHeight: '0' },
  '.cm-search .cm-button': { padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--hairline-strong)', backgroundImage: 'none', backgroundColor: 'var(--sheet)', color: 'var(--ink)', minHeight: '0' },
  '.cm-search button[name=close]': { marginLeft: 'auto', fontSize: '18px', lineHeight: '1', padding: '0 4px', background: 'none', border: 'none', color: 'var(--muted)', minHeight: '0' },
});

/** Completions for `a.b.` paths from the template's documented variables. */
function properties(variables: CodeVariable[]) {
  return (path: readonly string[]): readonly Completion[] => {
    const prefix = `${path.join('.')}.`;
    const seen = new Set<string>();
    const out: Completion[] = [];
    for (const v of variables) {
      if (!v.name.startsWith(prefix)) continue;
      const rest = v.name.slice(prefix.length).split('.')[0]!;
      if (!rest || seen.has(rest)) continue;
      seen.add(rest);
      out.push({ label: rest, type: 'property', ...(v.name === prefix + rest && { info: v.description }) });
    }
    // Fields listed in a description ("lines: number, description, quantity…").
    if (!out.length) {
      const doc = variables.find((v) => v.name === path.join('.') || v.name === path[path.length - 1]);
      for (const field of doc?.description.match(/(?<=[:,]\s*)[a-z_]+(?=[,\s)]|$)/g) ?? []) {
        if (!seen.has(field)) {
          seen.add(field);
          out.push({ label: field, type: 'property' });
        }
      }
    }
    return out;
  };
}

function language(lang: 'html' | 'css', variables: CodeVariable[]) {
  const tops = new Map<string, string>();
  for (const v of variables) {
    if (v.name.startsWith('{%') || v.name.startsWith("'")) continue;
    const top = v.name.split('.')[0]!;
    if (!tops.has(top)) tops.set(top, v.name === top ? v.description : '');
  }
  return liquid({
    base: lang === 'css' ? css() : html({ selfClosingTags: true }),
    variables: [...tops].map(([label, info]) => ({ label, type: 'variable', ...(info && { info }) })),
    properties: properties(variables),
    filters: [
      { label: 'money', type: 'function', detail: 'BZ$1,234.50', info: 'An amount in Belize dollars' },
      { label: 'amount', type: 'function', detail: '1,234.50', info: 'An amount with two decimals, no currency' },
      { label: 'pluralize', type: 'function', detail: "'day', 'days'", info: 'The first word for 1, the second otherwise' },
      { label: 'asset_url', type: 'function', detail: "'logo.png' | asset_url", info: 'The address of an image you uploaded under Images' },
    ],
    tags: [{ label: 'bts', type: 'keyword', detail: 'required block', info: "BTS's QR code, ETDUI, authorization and legal notices. {% bts 'stacked' %} for narrow layouts." }],
  });
}

export const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string;
  language: 'html' | 'css';
  variables: CodeVariable[];
  problems: CodeProblem[];
  onChange: (value: string) => void;
  onSave: () => void;
  label: string;
}>(function CodeEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange: props.onChange, onSave: props.onSave });
  handlers.current = { onChange: props.onChange, onSave: props.onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), foldGutter({ openText: '▾', closedText: '▸' }), lintGutter(),
          highlightSpecialChars(), history(), drawSelection(), dropCursor(), EditorState.allowMultipleSelections.of(true),
          indentOnInput(), indentUnit.of('  '), bracketMatching(), closeBrackets(), autocompletion({ icons: false }),
          rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
          syntaxHighlighting(highlight), theme, EditorView.lineWrapping,
          language(props.language, props.variables),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, stopPropagation: true, run: () => (handlers.current.onSave(), true) },
            ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'aria-label': props.label }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // Made once per template (the parent keys this component by template).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new value from outside (a version opened, back to the default): replace the text.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === props.value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  // Problems from the server, on their lines.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const doc = v.state.doc;
    const diagnostics: Diagnostic[] = props.problems.filter((p) => p.line && p.line <= doc.lines).map((p) => {
      const line = doc.line(p.line!);
      const start = line.from + (line.text.length - line.text.trimStart().length);
      return { from: start, to: Math.max(start, line.to), severity: 'error', message: p.message };
    });
    v.dispatch(setDiagnostics(v.state, diagnostics));
  }, [props.problems]);

  useImperativeHandle(ref, () => ({
    insert(text) {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.changeByRange((range) => ({ changes: { from: range.from, to: range.to, insert: text }, range: EditorSelection.cursor(range.from + text.length) })));
      v.focus();
    },
    goToLine(n) {
      const v = view.current;
      if (!v) return;
      const line = v.state.doc.line(Math.min(Math.max(1, n), v.state.doc.lines));
      v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
      v.focus();
    },
    focus() {
      view.current?.focus();
    },
  }), []);

  return <div ref={host} className="code-editor" />;
});
