/** Simple line icons for the navigation (original, 20×20, drawn with the current text colour). */

import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const Icons = {
  overview: () => <Svg><rect x="3" y="3" width="6" height="7" rx="1.5" /><rect x="11" y="3" width="6" height="4" rx="1.5" /><rect x="11" y="9" width="6" height="8" rx="1.5" /><rect x="3" y="12" width="6" height="5" rx="1.5" /></Svg>,
  counter: () => <Svg><path d="M4 8h12l-1 8.5a1 1 0 0 1-1 .5H6a1 1 0 0 1-1-.5L4 8Z" /><path d="M7 8V6a3 3 0 0 1 6 0v2" /><path d="M8 12h4" /></Svg>,
  invoice: () => <Svg><path d="M6 2.5h6l3.5 3.5v10.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" /><path d="M12 2.5V6h3.5" /><path d="M10 9.5v5M7.5 12h5" /></Svg>,
  orders: () => <Svg><path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5v-7Z" /><path d="m3.5 6.5 6.5 3.5 6.5-3.5M10 10v7" /></Svg>,
  documents: () => <Svg><rect x="5" y="2.5" width="11" height="13" rx="1.5" /><path d="M4 5v11a1.5 1.5 0 0 0 1.5 1.5H13" /><path d="M8 6.5h5M8 9.5h5M8 12.5h3" /></Svg>,
  products: () => <Svg><path d="M10.6 3H16a1 1 0 0 1 1 1v5.4a1 1 0 0 1-.3.7l-6.8 6.8a1 1 0 0 1-1.4 0l-5.4-5.4a1 1 0 0 1 0-1.4l6.8-6.8a1 1 0 0 1 .7-.3Z" /><circle cx="13.5" cy="6.5" r="1.2" /></Svg>,
  customers: () => <Svg><circle cx="8" cy="7" r="3" /><path d="M2.5 16.5a5.5 5.5 0 0 1 11 0" /><path d="M13.5 4.2a3 3 0 0 1 0 5.6M15.5 12.2a5.5 5.5 0 0 1 2 4.3" /></Svg>,
  reports: () => <Svg><path d="M3 17h14" /><rect x="4.5" y="9" width="2.5" height="6" rx=".6" /><rect x="8.75" y="5" width="2.5" height="10" rx=".6" /><rect x="13" y="11" width="2.5" height="4" rx=".6" /></Svg>,
  settings: () => <Svg><circle cx="10" cy="10" r="2.5" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></Svg>,
  store: () => <Svg><path d="M3.5 8V16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8" /><path d="M2.5 4.5 4 2.5h12l1.5 2v1.5a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0V4.5Z" /><path d="M8 17v-4h4v4" /></Svg>,
  external: () => <Svg><path d="M11 3.5h5.5V9M16.5 3.5 9.5 10.5" /><path d="M14 12v3.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H8" /></Svg>,
  logout: () => <Svg><path d="M8 3.5H5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3" /><path d="M12.5 6.5 16 10l-3.5 3.5M16 10H8" /></Svg>,
  swap: () => <Svg><path d="M4 7h11l-3-3M16 13H5l3 3" /></Svg>,
  menu: () => <Svg><path d="M3.5 6h13M3.5 10h13M3.5 14h13" /></Svg>,
  close: () => <Svg><path d="M5 5l10 10M15 5 5 15" /></Svg>,
  arrow: () => <Svg><path d="M4 10h12M11 5l5 5-5 5" /></Svg>,
  quote: () => <Svg><path d="M5 3.5h10a1 1 0 0 1 1 1v12l-2.5-1.5L11 16.5l-2.5-1.5L6 16.5l-2-1.2V4.5a1 1 0 0 1 1-1Z" /><path d="M7.5 7.5h5M7.5 10.5h5M7.5 13h2.5" /></Svg>,
  repeat: () => <Svg><path d="M4 9V8a3 3 0 0 1 3-3h8l-2.5-2.5" /><path d="M16 11v1a3 3 0 0 1-3 3H5l2.5 2.5" /></Svg>,
  expense: () => <Svg><path d="M6 2.5h8a1 1 0 0 1 1 1v14l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3V3.5a1 1 0 0 1 1-1Z" /><path d="M10 6v6M12 7.2c-.4-.5-1.1-.8-2-.8-1.1 0-2 .6-2 1.4s.9 1.2 2 1.4 2 .6 2 1.4-.9 1.4-2 1.4c-.9 0-1.6-.3-2-.8" /></Svg>,
  inventory: () => <Svg><path d="M3 7.5 10 4l7 3.5v8.5H3V7.5Z" /><path d="M6 16v-5h8v5M6 13.5h8" /></Svg>,
  register: () => <Svg><rect x="3" y="9" width="14" height="8" rx="1.5" /><path d="M5 9V4.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V9" /><path d="M8 6.5h4M3 13h14" /></Svg>,
  wallet: () => <Svg><path d="M3.5 6.5a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1V7" /><rect x="3.5" y="6.5" width="13" height="9.5" rx="1.8" /><path d="M16.5 10h-3a1.5 1.5 0 0 0 0 3h3" /><circle cx="13.6" cy="11.5" r=".4" /></Svg>,
  alert: () => <Svg><path d="M10 3 2.5 16.5h15L10 3Z" /><path d="M10 8.5v3.5M10 14.3v.2" /></Svg>,
  templates: () => <Svg><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M2.5 7h15" /><path d="m8 10-2 2 2 2M12 10l2 2-2 2" /></Svg>,
  clock: () => <Svg><circle cx="10" cy="10" r="7" /><path d="M10 6v4.2l2.8 1.8" /></Svg>,
  check: () => <Svg><circle cx="10" cy="10" r="7" /><path d="m7 10 2 2 4-4" /></Svg>,
  giftCard: () => <Svg><rect x="2.5" y="5.5" width="15" height="10" rx="1.8" /><path d="M2.5 9.5h15M7.5 5.5v10" /><path d="M7.5 9.5C6 7 3.8 7 3.8 8.2s2.2 1.3 3.7 1.3Zm0 0C9 7 11.2 7 11.2 8.2S9 9.5 7.5 9.5Z" /></Svg>,
};
