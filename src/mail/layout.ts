/**
 * The one layout for emails built in code (sign-in, invitations, notices to a
 * business): who it is from at the top (a logo, or the name), a heading, the
 * text, at most one button, a footer. The same look as the templates a
 * business can edit (src/templates/defaults/email-*.liquid).
 *
 * Built for phones first: one column, at most 560 px wide, 15 px text, a
 * button big enough for a thumb, no images needed to read it. Every value is
 * escaped; a link that is not http(s) or mailto is left out.
 */

/** Escaping for values put into an email's HTML (text and attribute values). */
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A link safe to put in an href, or null. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  return /^(https?:\/\/|mailto:)[^\s<>"]+$/i.test(trimmed) ? trimmed : null;
}

export interface EmailBrand {
  /** Shown at the top when there is no logo, and as the logo's description. */
  name: string;
  logoUrl?: string | null;
}

export interface EmailParts {
  heading: string;
  paragraphs: string[];
  button?: { label: string; url: string } | undefined;
  /** Who the email is from. Default: the platform. */
  brand?: EmailBrand | undefined;
  /** Small print under the text. */
  footer?: string[] | undefined;
}

export const PLATFORM_BRAND: EmailBrand = { name: 'Floreo' };

/** The email as HTML. */
export function emailHtml(parts: EmailParts): string {
  const brand = parts.brand ?? PLATFORM_BRAND;
  const logo = safeUrl(brand.logoUrl);
  const top = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(brand.name)}" height="40" style="display:block;height:40px;width:auto;max-width:220px;border:0;margin:0 0 14px">`
    : `<div style="font-size:13px;color:#646b7b">${escapeHtml(brand.name)}</div>`;
  const text = parts.paragraphs.map((p) => `<p style="margin:0 0 14px;white-space:pre-line">${escapeHtml(p)}</p>`).join('\n          ');
  const url = safeUrl(parts.button?.url);
  const button = parts.button && url
    ? `
        <tr><td style="padding:8px 32px 4px">
          <a href="${escapeHtml(url)}" style="display:inline-block;background:#6d2d93;color:#ffffff;padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:600;font-size:15px">${escapeHtml(parts.button.label)}</a>
        </td></tr>`
    : '';
  const footer = (parts.footer ?? []).map(escapeHtml).join('<br>');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(parts.heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1117">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6e8ec;border-radius:14px">
        <tr><td style="padding:28px 32px 6px">
          ${top}
          <h1 style="margin:6px 0 0;font-size:22px;line-height:1.25;letter-spacing:-0.02em">${escapeHtml(parts.heading)}</h1>
        </td></tr>
        <tr><td style="padding:14px 32px 4px;font-size:15px;line-height:1.6">
          ${text}
        </td></tr>${button}
        <tr><td style="padding:${footer ? '22px' : '6px'} 32px 28px;font-size:12px;line-height:1.6;color:#646b7b">${footer}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** The same email as plain text. */
export function emailText(parts: EmailParts): string {
  const url = safeUrl(parts.button?.url);
  return [...parts.paragraphs, ...(parts.button && url ? [`${parts.button.label}:\n${url}`] : []), ...(parts.footer?.length ? ['', ...parts.footer] : [])].join('\n\n');
}

/** A heading, paragraphs and an optional button, in the shared layout (the name callers have always used). */
export function simpleHtml(opts: EmailParts): string {
  return emailHtml(opts);
}

/** Add a line of small print to a finished HTML email (the way to stop emails like it), inside the page. */
export function withFooterLine(html: string, lineHtml: string): string {
  const block = `<div style="max-width:560px;margin:0 auto;padding:0 12px 24px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#646b7b;text-align:center">${lineHtml}</div>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${block}</body>`) : html + block;
}
