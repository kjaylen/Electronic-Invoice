/**
 * The customer display (desktop app, second screen): the items, the total and
 * the change, sent by the till through the desktop app (window.tillDisplay).
 */

import './pos.css';
import '../styles.css';
import type { DisplayState } from './platform';

declare global {
  interface Window {
    tillDisplay?: { onUpdate(listener: (state: DisplayState) => void): void };
  }
}

const money = (v: string) => `BZ$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const el = (tag: string, className: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

function render(state: DisplayState | null) {
  const root = document.getElementById('root')!;
  root.replaceChildren();
  const page = el('div', 'display');
  page.append(el('div', 'display-head', state?.business ?? ''));
  if (!state || (!state.lines.length && !state.message)) {
    page.append(el('div', 'display-message', 'Welcome'));
  } else if (state.message) {
    page.append(el('div', 'display-message', state.message));
    const total = el('div', 'display-total');
    total.append(el('span', '', 'Total'), el('span', '', money(state.total)));
    page.append(total);
    if (state.change) page.append(el('div', 'display-change', `Change ${money(state.change)}`));
  } else {
    const lines = el('div', 'display-lines');
    for (const l of state.lines.slice(-8)) {
      const row = el('div', '');
      row.append(el('span', '', `${l.quantity !== '1' ? `${l.quantity} × ` : ''}${l.name}`), el('span', '', l.amount ? money(l.amount) : ''));
      lines.append(row);
    }
    const total = el('div', 'display-total');
    total.append(el('span', '', 'Total'), el('span', '', money(state.total)));
    page.append(lines, total);
    if (state.usd) page.append(el('div', 'display-change', `US$${Number(state.usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`));
    if (state.change) page.append(el('div', 'display-change', `Change ${money(state.change)}`));
  }
  root.append(page);
}

render(null);
window.tillDisplay?.onUpdate(render);
