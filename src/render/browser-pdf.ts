/**
 * PDFs from HTML templates, printed by a headless Chromium (playwright-core).
 *
 * Templates are written by businesses, so the page is shut in: no JavaScript, no network (only
 * data: URLs load, so a template cannot make the server fetch anything), a time limit per page.
 * One browser serves every PDF; each print gets its own throwaway context.
 *
 * Configured once at start-up (buildApp's pdfRenderer). Without it, or if Chromium cannot start,
 * documents fall back to the built-in pdfkit layouts, so issuing never depends on a browser.
 */

import type { Browser } from 'playwright-core';

export type PdfPage = { size: 'css' } | { widthMm: number };

export interface HtmlPdfRenderer {
  /** Print HTML to PDF: at the page size its CSS asks for, or a roll width with the height of the content. */
  pdf(html: string, page: PdfPage): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * A renderer on a local Chromium: the one Playwright installs, an installed Chrome or Edge
 * (`channel`: "chrome", "msedge"), or any build at `executablePath`.
 */
export function chromiumRenderer(options: { executablePath?: string; channel?: string; timeoutMs?: number } = {}): HtmlPdfRenderer {
  let browser: Promise<Browser> | null = null;
  // After a failed start, wait a while before trying again (each print falls back meanwhile).
  let failed: { at: number; error: Error } | null = null;
  const RETRY_MS = 5 * 60_000;
  const timeout = options.timeoutMs ?? 15_000;
  const launch = () => {
    if (failed && Date.now() - failed.at < RETRY_MS) return Promise.reject(failed.error);
    browser ??= import('playwright-core').then(({ chromium }) => chromium.launch({
      headless: true, ...(options.executablePath && { executablePath: options.executablePath }), ...(options.channel && { channel: options.channel }),
    }))
      .then((b) => {
        failed = null;
        // If it ever goes away, start a new one next time.
        b.on('disconnected', () => {
          browser = null;
        });
        return b;
      })
      .catch((e: Error) => {
        browser = null;
        // Playwright's message carries a boxed install banner: keep the first line.
        failed = { at: Date.now(), error: new Error(`The PDF browser did not start (${e.message.split('\n')[0]})`) };
        throw failed.error;
      });
    return browser;
  };
  return {
    async pdf(html, page) {
      const b = await launch();
      const context = await b.newContext({ javaScriptEnabled: false, offline: true, ...('widthMm' in page && { viewport: { width: Math.round((page.widthMm * 96) / 25.4), height: 800 } }) });
      try {
        await context.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
        const p = await context.newPage();
        p.setDefaultTimeout(timeout);
        await p.setContent(html, { waitUntil: 'load', timeout });
        if ('widthMm' in page) {
          const box = await p.locator('html').boundingBox();
          const heightPx = Math.ceil((box?.height ?? 800) + 4);
          return await p.pdf({ width: `${page.widthMm}mm`, height: `${heightPx}px`, printBackground: true, preferCSSPageSize: false, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
        }
        return await p.pdf({ preferCSSPageSize: true, printBackground: true, format: 'A4' });
      } finally {
        await context.close().catch(() => {});
      }
    },
    async close() {
      const b = browser;
      browser = null;
      if (b) await (await b.catch(() => null))?.close().catch(() => {});
    },
  };
}

let current: HtmlPdfRenderer | null = null;
/** Set (or clear) the process's HTML-to-PDF renderer. */
export function setPdfRenderer(r: HtmlPdfRenderer | null) {
  current = r;
}
export const pdfRenderer = () => current;
