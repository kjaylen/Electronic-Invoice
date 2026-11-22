/**
 * /docs: the API reference, rendered from /v1/openapi.json (which the server
 * builds from its own route schemas), with guides for authentication,
 * errors, idempotency, rate limits and webhook signatures.
 */

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Brand } from '../art';
import { LanguageToggle, useT } from '../i18n';
import { usePageTitle } from '../ui';

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  description?: string;
  oneOf?: Schema[];
  anyOf?: Schema[];
};

interface Operation {
  tags: string[];
  summary: string;
  operationId: string;
  parameters: Array<{ name: string; in: 'path' | 'query' | 'header'; required: boolean; schema: Schema; description?: string }>;
  requestBody?: { content: { 'application/json': { schema: Schema } } };
}

interface Spec {
  info: { title: string; description: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, Operation>>;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const typeOf = (s: Schema): string => {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type ?? (s.oneOf || s.anyOf ? 'one of' : 'any');
  return t === 'array' && s.items ? `${typeOf(s.items)}[]` : t;
};
const limits = (s: Schema) => [
  s.pattern && `pattern ${s.pattern}`,
  s.format && s.format,
  s.minLength !== undefined && `min ${s.minLength} chars`,
  s.maxLength !== undefined && `max ${s.maxLength} chars`,
  s.minimum !== undefined && `≥ ${s.minimum}`,
  s.maximum !== undefined && `≤ ${s.maximum}`,
].filter(Boolean).join(' · ');

/** A small, safe renderer for the spec's markdown: headings, paragraphs, inline code. */
function Markdown({ text }: { text: string }) {
  const inline = (line: string): ReactNode[] => line.split(/(`[^`]+`)/g).map((part, i) => (part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        if (b.startsWith('## ')) {
          const [head, ...rest] = b.split('\n');
          const title = head!.slice(3);
          return (
            <section key={i} id={slug(title)} className="doc-guide">
              <h2>{title}</h2>
              {rest.length > 0 && <p>{inline(rest.join(' '))}</p>}
            </section>
          );
        }
        return <p key={i}>{inline(b.replace(/\n/g, ' '))}</p>;
      })}
    </>
  );
}

function Fields({ schema, depth = 0 }: { schema: Schema; depth?: number }) {
  const props = schema.properties ?? schema.items?.properties;
  if (!props || depth > 3) return null;
  const required = schema.required ?? schema.items?.required ?? [];
  return (
    <ul className={`doc-fields depth-${depth}`}>
      {Object.entries(props).map(([name, s]) => (
        <li key={name}>
          <div className="row">
            <code className="doc-field-name">{name}</code>
            <span className="doc-type">{typeOf(s)}</span>
            {required.includes(name) && <span className="doc-required">required</span>}
          </div>
          {(limits(s) || s.description) && <div className="small muted">{[s.description, limits(s)].filter(Boolean).join(' · ')}</div>}
          {(s.properties || s.items?.properties) && <Fields schema={s} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

const ISSUE_EXAMPLE = {
  type: '01',
  customerId: '7d1f…',
  lines: [
    { itemId: '0c2a…', quantity: '2' },
    { description: 'Gift wrap', quantity: '1', unitCode: 'H87', unitPrice: '5.00', gstCategory: 'S' },
  ],
  payment: { meansCode: '30', dueDate: '2026-12-31', terms: 'Net 30' },
};

function example(s: Schema, depth = 0): unknown {
  if (depth > 4) return null;
  if (s.enum) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (type === 'object' || s.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) if ((s.required ?? []).includes(k)) out[k] = example(v, depth + 1);
    return out;
  }
  if (type === 'array') return s.items ? [example(s.items, depth + 1)] : [];
  if (type === 'integer' || type === 'number') return s.minimum ?? 1;
  if (type === 'boolean') return true;
  if (s.pattern?.includes('\\d')) return '10.00';
  return '…';
}

function Curl({ method, path, op, server }: { method: string; path: string; op: Operation; server: string }) {
  const base = server === '/' ? 'https://app.example.bz' : server.replace(/\/$/, '');
  const body = op.requestBody ? (method === 'post' && path === '/v1/documents' ? ISSUE_EXAMPLE : example(op.requestBody.content['application/json'].schema)) : null;
  const lines = [
    `curl -X ${method.toUpperCase()} '${base}${path.replace(/\{(\w+)\}/g, ':$1')}' \\`,
    `  -H 'Authorization: Bearer etd_…'${body ? ' \\' : ''}`,
    ...(body ? [`  -H 'Content-Type: application/json' \\`, `  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n     ')}'`] : []),
  ];
  return <pre className="doc-code">{lines.join('\n')}</pre>;
}

const NODE_VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body exactly as received (a string), before JSON parsing.
export function verify(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (Math.abs(Date.now() / 1000 - t) > 300) return false; // older than 5 minutes
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}`;

export function Docs() {
  const t = useT();
  usePageTitle(t('API reference'));
  const [spec, setSpec] = useState<Spec | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    void api<Spec>('/v1/openapi.json').then(setSpec).catch(() => setError(true));
  }, []);
  useEffect(() => {
    if (spec && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [spec]);
  const groups = useMemo(() => {
    if (!spec) return [];
    const ops = Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, op })));
    const needle = q.trim().toLowerCase();
    return spec.tags.map((tag) => ({
      tag,
      ops: ops.filter((o) => o.op.tags.includes(tag.name) && (!needle || `${o.method} ${o.path} ${o.op.summary}`.toLowerCase().includes(needle))),
    })).filter((g) => g.ops.length);
  }, [spec, q]);
  const guides = spec ? [...spec.info.description.matchAll(/^## (.+)$/gm)].map((m) => m[1]!) : [];

  return (
    <div className="docs-page">
      <header className="docs-top">
        <Link to="/" className="brand"><Brand /></Link>
        <span className="kicker">{t('API reference')}</span>
        <span className="spacer" />
        <a className="button secondary small-button" href="/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI JSON</a>
        <LanguageToggle />
      </header>
      <div className="docs-body">
        <nav className="docs-nav" aria-label={t('API reference')}>
          <input type="search" placeholder={t('Search endpoints')} aria-label={t('Search endpoints')} value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="docs-nav-head">{t('Guides')}</span>
          {guides.map((g) => <a key={g} href={`#${slug(g)}`}>{g}</a>)}
          <a href="#verify-signatures">{t('Checking signatures')}</a>
          {groups.map((g) => (
            <div key={g.tag.name}>
              <a className="docs-nav-head" href={`#${slug(g.tag.name)}`}>{g.tag.name}</a>
              {g.ops.map((o) => <a key={o.op.operationId} href={`#${o.op.operationId}`} className="docs-nav-op"><span className={`method ${o.method}`}>{o.method.toUpperCase()}</span>{o.path.replace('/v1', '')}</a>)}
            </div>
          ))}
        </nav>
        <main className="docs-main">
          {error && <div className="banner bad"><div><strong>{t('The API description could not be loaded.')}</strong></div></div>}
          {!spec ? !error && <div className="skeleton" style={{ height: '20rem' }} /> : (
            <>
              <h1>{spec.info.title}</h1>
              <Markdown text={spec.info.description} />
              <section id="verify-signatures" className="doc-guide">
                <h2>{t('Checking signatures')}</h2>
                <p>{t('In Node.js (the same idea in any language): recompute the HMAC of "<t>.<raw body>" with your secret and compare in constant time.')}</p>
                <pre className="doc-code">{NODE_VERIFY}</pre>
              </section>
              {groups.map((g) => (
                <section key={g.tag.name} id={slug(g.tag.name)} className="doc-tag">
                  <h2>{g.tag.name}</h2>
                  <p className="muted">{g.tag.description}</p>
                  {g.ops.map(({ path, method, op }) => (
                    <article key={op.operationId} id={op.operationId} className="card doc-op">
                      <div className="row doc-op-head">
                        <span className={`method ${method}`}>{method.toUpperCase()}</span>
                        <code className="doc-path">{path}</code>
                      </div>
                      <p>{op.summary}</p>
                      {op.parameters.length > 0 && (
                        <>
                          <h4>{t('Parameters')}</h4>
                          <ul className="doc-fields">
                            {op.parameters.map((p) => (
                              <li key={`${p.in}-${p.name}`}>
                                <div className="row"><code className="doc-field-name">{p.name}</code><span className="doc-type">{p.in} · {typeOf(p.schema)}</span>{p.required && <span className="doc-required">required</span>}</div>
                                {(p.description || limits(p.schema)) && <div className="small muted">{[p.description, limits(p.schema)].filter(Boolean).join(' · ')}</div>}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {op.requestBody && (
                        <>
                          <h4>{t('Body')}</h4>
                          <Fields schema={op.requestBody.content['application/json'].schema} />
                        </>
                      )}
                      <Curl method={method} path={path} op={op} server={spec.servers[0]?.url ?? '/'} />
                    </article>
                  ))}
                </section>
              ))}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
