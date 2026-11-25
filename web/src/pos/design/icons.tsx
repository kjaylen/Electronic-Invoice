/**
 * The till's icons: one set, original, drawn on a 20×20 grid with a 1.6 stroke and round ends in the
 * current text colour (the same style as the web app's icons.tsx). Decorative: the text beside an icon
 * says what it means (primary actions always have a label).
 */

import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const PosIcon = {
  sell: () => <Svg><path d="M4 7.5h12l-1 8.5a1 1 0 0 1-1 .9H6a1 1 0 0 1-1-.9L4 7.5Z" /><path d="M7 7.5V6a3 3 0 0 1 6 0v1.5" /></Svg>,
  receipt: () => <Svg><path d="M5 2.5h10v15l-2-1.3-1.7 1.3-1.6-1.3-1.7 1.3L6.3 16 5 17.5v-15Z" /><path d="M7.5 6.5h5M7.5 9.5h5M7.5 12.5h3" /></Svg>,
  drawer: () => <Svg><rect x="2.5" y="9" width="15" height="8" rx="1.5" /><path d="M5 9V4.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V9" /><path d="M8 13h4" /></Svg>,
  floor: () => <Svg><rect x="2.5" y="2.5" width="15" height="15" rx="2" /><circle cx="7" cy="7" r="2" /><rect x="11" y="5" width="4" height="4" rx=".8" /><rect x="5" y="11.5" width="10" height="3.5" rx=".8" /></Svg>,
  kitchen: () => <Svg><path d="M5 9a5 5 0 0 1 10 0v1H5V9Z" /><path d="M3 12.5h14" /><path d="M10 4V2.5" /><path d="M6 15.5h8" /></Svg>,
  devices: () => <Svg><rect x="2.5" y="4" width="10" height="7.5" rx="1.2" /><path d="M5 15.5h5M7.5 11.5v4" /><rect x="14" y="7" width="3.5" height="8.5" rx="1" /></Svg>,
  sync: () => <Svg><path d="M4.5 8a6 6 0 0 1 10.6-2.2L16.5 7.5" /><path d="M16.5 3.5v4h-4" /><path d="M15.5 12a6 6 0 0 1-10.6 2.2L3.5 12.5" /><path d="M3.5 16.5v-4h4" /></Svg>,
  printer: () => <Svg><path d="M5.5 7.5V3h9v4.5" /><rect x="2.5" y="7.5" width="15" height="7" rx="1.5" /><path d="M5.5 12.5h9V17h-9z" /></Svg>,
  wifi: () => <Svg><path d="M2.5 7.5a11 11 0 0 1 15 0" /><path d="M5 10.5a7.2 7.2 0 0 1 10 0" /><path d="M7.6 13.4a3.4 3.4 0 0 1 4.8 0" /><circle cx="10" cy="16" r=".8" fill="currentColor" /></Svg>,
  wifiOff: () => <Svg><path d="M2.5 7.5a11 11 0 0 1 4.1-2.6M10 4.2a11 11 0 0 1 7.5 3.3" /><path d="M5 10.5a7.2 7.2 0 0 1 3-1.6M13.3 9.4c.6.3 1.2.7 1.7 1.1" /><path d="M7.6 13.4a3.4 3.4 0 0 1 4.8 0" /><path d="M3 3l14 14" /></Svg>,
  switchUser: () => <Svg><circle cx="8" cy="6.5" r="3" /><path d="M2.5 16.5a5.5 5.5 0 0 1 9-4.2" /><path d="M13 13.5h5M16 11.5l2 2-2 2M18 17h-5" /></Svg>,
  lock: () => <Svg><rect x="4" y="9" width="12" height="8.5" rx="1.5" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></Svg>,
  search: () => <Svg><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4" /></Svg>,
  barcode: () => <Svg><path d="M3 4.5v11M5.5 4.5v11M8.5 4.5v11M10.5 4.5v11M13.5 4.5v11M15.5 4.5v11M17 4.5v11" /></Svg>,
  plus: () => <Svg><path d="M10 4.5v11M4.5 10h11" /></Svg>,
  minus: () => <Svg><path d="M4.5 10h11" /></Svg>,
  close: () => <Svg><path d="M5 5l10 10M15 5 5 15" /></Svg>,
  back: () => <Svg><path d="M12 4.5 6.5 10l5.5 5.5" /></Svg>,
  check: () => <Svg><path d="m4.5 10.5 3.5 3.5 7.5-8" /></Svg>,
  backspace: () => <Svg><path d="M7 4.5h9.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H7L2.5 10 7 4.5Z" /><path d="m10 8 4 4M14 8l-4 4" /></Svg>,
  cash: () => <Svg><rect x="2.5" y="5" width="15" height="10" rx="1.5" /><circle cx="10" cy="10" r="2.2" /><path d="M5 7.5v.01M15 12.5v.01" /></Svg>,
  card: () => <Svg><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" /><path d="M2.5 8h15M5.5 12.5h3" /></Svg>,
  transfer: () => <Svg><path d="M3.5 7h12l-3-3M16.5 13h-12l3 3" /></Svg>,
  split: () => <Svg><path d="M10 3v5M10 8l-5 5v4M10 8l5 5v4" /></Svg>,
  gift: () => <Svg><rect x="3" y="7.5" width="14" height="4" rx="1" /><path d="M4.5 11.5v6h11v-6M10 7.5v10" /><path d="M10 7.5C8.5 4 5.5 4.5 6 6.5s4 1 4 1 3.5 1 4-1-2.5-2.5-4 1Z" /></Svg>,
  percent: () => <Svg><path d="M15 5 5 15" /><circle cx="6" cy="6" r="1.8" /><circle cx="14" cy="14" r="1.8" /></Svg>,
  note: () => <Svg><path d="M4.5 3.5h11v9l-4 4h-7v-13Z" /><path d="M11.5 16.5v-4h4" /><path d="M7 7h6M7 10h4" /></Svg>,
  trash: () => <Svg><path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l.8 11a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.8-11" /></Svg>,
  undo: () => <Svg><path d="M7 4.5 3.5 8 7 11.5" /><path d="M3.5 8h8a5 5 0 0 1 0 10H8" /></Svg>,
  redo: () => <Svg><path d="M13 4.5 16.5 8 13 11.5" /><path d="M16.5 8h-8a5 5 0 0 0 0 10H12" /></Svg>,
  person: () => <Svg><circle cx="10" cy="6.5" r="3.2" /><path d="M3.5 17a6.5 6.5 0 0 1 13 0" /></Svg>,
  people: () => <Svg><circle cx="7.5" cy="7" r="2.8" /><path d="M2.5 16.5a5 5 0 0 1 10 0" /><path d="M13 4.6a2.8 2.8 0 0 1 0 5.2M14.5 11.6a5 5 0 0 1 3 4.9" /></Svg>,
  clock: () => <Svg><circle cx="10" cy="10" r="7" /><path d="M10 6v4.2l2.8 1.8" /></Svg>,
  alert: () => <Svg><path d="M10 3 2.5 16.5h15L10 3Z" /><path d="M10 8.5v3.5M10 14.3v.2" /></Svg>,
  info: () => <Svg><circle cx="10" cy="10" r="7" /><path d="M10 9v4.5M10 6.5v.2" /></Svg>,
  done: () => <Svg><circle cx="10" cy="10" r="7" /><path d="m7 10 2 2 4-4" /></Svg>,
  error: () => <Svg><circle cx="10" cy="10" r="7" /><path d="m7.5 7.5 5 5M12.5 7.5l-5 5" /></Svg>,
  more: () => <Svg><circle cx="5" cy="10" r=".9" fill="currentColor" /><circle cx="10" cy="10" r=".9" fill="currentColor" /><circle cx="15" cy="10" r=".9" fill="currentColor" /></Svg>,
  list: () => <Svg><path d="M7 5.5h10M7 10h10M7 14.5h10" /><path d="M3 5.5h.01M3 10h.01M3 14.5h.01" /></Svg>,
  plan: () => <Svg><rect x="2.5" y="2.5" width="6" height="6" rx="1.2" /><rect x="11.5" y="2.5" width="6" height="6" rx="3" /><rect x="2.5" y="11.5" width="15" height="6" rx="1.2" /></Svg>,
  zoomIn: () => <Svg><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4M9 6.5v5M6.5 9h5" /></Svg>,
  zoomOut: () => <Svg><circle cx="9" cy="9" r="5.5" /><path d="m13 13 4 4M6.5 9h5" /></Svg>,
  fit: () => <Svg><path d="M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5" /></Svg>,
  legend: () => <Svg><rect x="3" y="3.5" width="4" height="4" rx="1" /><rect x="3" y="12.5" width="4" height="4" rx="1" /><path d="M10 5.5h7M10 14.5h7" /></Svg>,
  move: () => <Svg><path d="M10 2.5v15M2.5 10h15M10 2.5 8 4.5M10 2.5l2 2M10 17.5l-2-2M10 17.5l2-2M2.5 10l2-2M2.5 10l2 2M17.5 10l-2-2M17.5 10l-2 2" /></Svg>,
  merge: () => <Svg><path d="M4 3.5v3a4 4 0 0 0 4 4h4M16 3.5v3a4 4 0 0 1-4 4M10 10.5v7" /></Svg>,
  rotate: () => <Svg><path d="M15.5 9.5A5.5 5.5 0 1 1 13.8 5" /><path d="M14.5 2.5v3.2h-3.2" /></Svg>,
  copy: () => <Svg><rect x="6.5" y="6.5" width="10" height="10" rx="1.5" /><path d="M13.5 6.5V4.5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" /></Svg>,
  alignLeft: () => <Svg><path d="M3 2.5v15" /><rect x="5.5" y="5" width="10" height="3.5" rx=".8" /><rect x="5.5" y="11.5" width="6" height="3.5" rx=".8" /></Svg>,
  alignTop: () => <Svg><path d="M2.5 3h15" /><rect x="5" y="5.5" width="3.5" height="10" rx=".8" /><rect x="11.5" y="5.5" width="3.5" height="6" rx=".8" /></Svg>,
  distribute: () => <Svg><path d="M2.5 3v14M17.5 3v14" /><rect x="5.5" y="6" width="3" height="8" rx=".8" /><rect x="11.5" y="6" width="3" height="8" rx=".8" /></Svg>,
  bell: () => <Svg><path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 2h-13l1.5-2Z" /><path d="M8.5 17.5h3" /></Svg>,
  sparkle: () => <Svg><path d="M10 3v4M10 13v4M3 10h4M13 10h4" /><path d="M6 6l1.5 1.5M12.5 12.5 14 14M14 6l-1.5 1.5M7.5 12.5 6 14" /></Svg>,
  flame: () => <Svg><path d="M10 17.5c-3 0-5-2-5-4.8 0-3.2 3-4.7 3-8.2 2 1 5 3.8 5 6.3 0 0 .8-.8 1-2.3 1 1 1.5 2.5 1.5 4.1 0 2.9-2.5 4.9-5.5 4.9Z" /></Svg>,
  plate: () => <Svg><circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3.5" /></Svg>,
  sun: () => <Svg><circle cx="10" cy="10" r="3.5" /><path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1 1M14.3 14.3l1 1M4.7 15.3l1-1M14.3 5.7l1-1" /></Svg>,
  moon: () => <Svg><path d="M16 12.5A6.5 6.5 0 1 1 7.5 4a5.2 5.2 0 0 0 8.5 8.5Z" /></Svg>,
  filter: () => <Svg><path d="M3 4.5h14l-5.5 6.5v5l-3 1.5v-6.5L3 4.5Z" /></Svg>,
  star: () => <Svg><path d="m10 3 2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7L3.2 8l4.7-.7L10 3Z" /></Svg>,
  wall: () => <Svg><rect x="2.5" y="8.5" width="15" height="3" rx=".5" /></Svg>,
  door: () => <Svg><path d="M4 17.5V3.5h9v14M13 17.5h3" /><path d="M10.5 10.5h.01" /></Svg>,
  table: () => <Svg><rect x="4" y="6" width="12" height="8" rx="1.5" /><circle cx="10" cy="3.5" r="1.2" /><circle cx="10" cy="16.5" r="1.2" /></Svg>,
  roundTable: () => <Svg><circle cx="10" cy="10" r="4.5" /><circle cx="10" cy="3" r="1.2" /><circle cx="10" cy="17" r="1.2" /><circle cx="3" cy="10" r="1.2" /><circle cx="17" cy="10" r="1.2" /></Svg>,
  stool: () => <Svg><circle cx="10" cy="7" r="3.5" /><path d="M8 10.5 6.5 17M12 10.5l1.5 6.5M7.3 14h5.4" /></Svg>,
} as const;

export type PosIconName = keyof typeof PosIcon;
