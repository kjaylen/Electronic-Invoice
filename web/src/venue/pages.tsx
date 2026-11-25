/** The hospitality screens as pages of the web app (the tills mount the same components themselves). */

import { useCallback } from 'react';
import { useT } from '../i18n';
import { Counter } from '../pages/Counter';
import { printInBrowser } from '../pos/hardware';
import { type Ticket, toHtml } from '../pos/ticket';
import { usePageTitle } from '../ui';
import { VenueFloor } from './Floor';
import { KitchenScreen } from './Kitchen';

export function FloorPage() {
  const t = useT();
  usePageTitle(t('Floor'));
  const print = useCallback((ticket: Ticket, title: string) => printInBrowser(toHtml(ticket, { paperWidth: 80 }, title)), []);
  return <VenueFloor counter={<Counter />} print={print} />;
}

export function KitchenPage() {
  const t = useT();
  usePageTitle(t('Kitchen'));
  return <KitchenScreen />;
}
