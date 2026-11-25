/**
 * The component gallery: every component of the till's design system in every state, in the theme
 * chosen at the top. Development builds only (/pos.html?gallery with Vite's dev server); it is not in
 * a built till. docs/design/DESIGN-SYSTEM.md describes each piece.
 */

import { type ReactNode, useState } from 'react';
import { Badge, Banner, Button, CategoryTabs, Chip, EmptyState, Icon, ListRow, NumPad, ProductTile, SearchField, Sheet, Skeleton, Stepper, Toggle, typeAmount } from './components';
import { PosIcon, type PosIconName } from './icons';
import { useTheme } from './theme';
import { TableShape, TABLE_STATES } from './table';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="gallery-section"><h2>{title}</h2><div className="gallery-row">{children}</div></section>;
}

function Swatch({ name }: { name: string }) {
  return <div className="gallery-swatch"><span style={{ background: `var(${name})` }} /><code>{name}</code></div>;
}

export function Gallery() {
  const [theme, setTheme] = useTheme();
  const [cat, setCat] = useState('all');
  const [qty, setQty] = useState(2);
  const [cash, setCash] = useState('');
  const [on, setOn] = useState(true);
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState(false);
  return (
    <div className="gallery">
      <header className="gallery-head">
        <div><span className="kicker">Development only</span><h1>Till design system</h1></div>
        <CategoryTabs label="Theme" value={theme} onChange={setTheme} options={[['light', 'Light'], ['dark', 'Dark'], ['system', 'Match the device']]} />
      </header>

      <Section title="Colour">
        {['--pos-brand', '--pos-bg', '--pos-surface', '--pos-surface-2', '--pos-surface-3', '--pos-border', '--pos-border-strong', '--pos-text', '--pos-text-2', '--pos-text-muted',
          '--pos-success', '--pos-warning', '--pos-danger', '--pos-info'].map((n) => <Swatch key={n} name={n} />)}
      </Section>

      <Section title="Type">
        <div className="gallery-type">
          <span style={{ fontSize: 'var(--pos-text-4xl)', fontWeight: 680 }} className="num">BZ$1,234.50</span>
          <span style={{ fontSize: 'var(--pos-text-3xl)', fontWeight: 680 }} className="num">BZ$56.25</span>
          <span style={{ fontSize: 'var(--pos-text-2xl)', fontWeight: 680 }}>Screen title 28</span>
          <span style={{ fontSize: 'var(--pos-text-xl)', fontWeight: 680 }}>Heading 22</span>
          <span style={{ fontSize: 'var(--pos-text-lg)' }}>Tile and row text 18</span>
          <span style={{ fontSize: 'var(--pos-text-md)' }}>Body text 16: the smallest reading size</span>
          <span style={{ fontSize: 'var(--pos-text-xs)', color: 'var(--pos-text-muted)' }}>Caption 14: nothing is smaller</span>
        </div>
      </Section>

      <Section title="Buttons">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="danger" icon="trash">Destructive</Button>
        <Button variant="primary" size="lg" icon="cash">Pay BZ$56.25</Button>
        <Button variant="secondary" selected>Selected</Button>
        <Button variant="primary" disabled>Disabled</Button>
        <Button variant="primary" loading>Loading</Button>
        <Button variant="secondary" error>Error</Button>
        <Button variant="secondary" className="is-pressed">Pressed</Button>
      </Section>

      <Section title="Product tiles">
        <div className="pos-tile-grid gallery-wide">
          <ProductTile name="Coconut water" price="BZ$3.94" colour="#2e9a4a" />
          <ProductTile name="Johnny cakes with butter" price="BZ$1.69" colour="#d9771c" stock={3} />
          <ProductTile name="Stew chicken" price="BZ$22.00" colour="#3f7fd0" selected />
          <ProductTile name="Conch fritters" price="BZ$14.00" out />
          <ProductTile name="Loading" price="BZ$0.00" loading />
        </div>
      </Section>

      <Section title="Category tabs">
        <CategoryTabs label="Category" value={cat} onChange={setCat} options={[['all', '★ Favourites'], ['drinks', 'Drinks'], ['food', 'Food'], ['desserts', 'Desserts']]} />
      </Section>

      <Section title="List rows">
        <ul className="pos-list gallery-wide">
          <li><ListRow lead={<Icon name="receipt" />} title="101-000000042" meta="Tax receipt · 13:05 · Rosa" amount="BZ$22.50" end={<Badge tone="success">Authorized</Badge>} /></li>
          <li><ListRow lead={<Icon name="receipt" />} title="101-000000043" meta="Saved on the till" amount="BZ$9.56" end={<Badge tone="brand" icon="sync">Not sent yet</Badge>} selected /></li>
          <li><ListRow lead={<Icon name="receipt" />} title="101-000000044" meta="Rejected by BTS" amount="BZ$3.94" end={<Badge tone="danger">Rejected</Badge>} error /></li>
        </ul>
      </Section>

      <Section title="Order line, stepper, number pad">
        <div className="gallery-col">
          <div className="pos-line"><div className="pos-line-body"><span><strong>Coconut water</strong><br /><span className="muted">2 × BZ$3.50</span></span><Stepper label="Quantity of Coconut water" value={qty} onChange={setQty} /><strong className="num">BZ$7.88</strong></div></div>
          <div className="pos-line"><div className="pos-line-body" style={{ transform: 'translateX(-30%)' }}><span><strong>Johnny cakes</strong></span><span /><strong className="num">BZ$1.69</strong></div><div className="pos-line-delete">Remove</div></div>
        </div>
        <div className="gallery-pad">
          <output className="gallery-amount num">BZ${cash || '0.00'}</output>
          <NumPad onKey={(k) => setCash((c) => typeAmount(c, k))} quick={[['20.00', 'BZ$20'], ['50.00', 'BZ$50'], ['100.00', 'BZ$100']]} onQuick={setCash} />
        </div>
      </Section>

      <Section title="Search, toggles, chips">
        <div className="gallery-col">
          <SearchField label="Search" placeholder="Scan a barcode or type a name" value={q} onChange={setQ} />
          <Toggle checked={on} onChange={setOn} label="Print each receipt" />
          <Toggle checked={false} onChange={() => {}} label="Disabled" disabled />
        </div>
        <Chip pressed icon="people">My tables</Chip>
        <Chip>All tables</Chip>
        <Chip disabled>Disabled</Chip>
      </Section>

      <Section title="Badges and banners">
        <Badge>Neutral</Badge><Badge tone="success">Success</Badge><Badge tone="warning">Warning</Badge><Badge tone="danger">Danger</Badge><Badge tone="info">Info</Badge><Badge tone="brand" icon="sync">Brand</Badge>
        <div className="gallery-col gallery-wide">
          <Banner tone="info" title="Offline">Sales are kept on this till and sent when the connection is back.</Banner>
          <Banner tone="success" title="Sent">Everything is on the server.</Banner>
          <Banner tone="warning" title="The receipt printer is not answering">Check that it is on and has paper, then print again from Sales.</Banner>
          <Banner tone="danger" title="The card was not charged" action={<Button variant="secondary">Try again</Button>}>Nothing was taken. Try again, or take cash.</Banner>
        </div>
      </Section>

      <Section title="Empty states and skeletons">
        <div className="card gallery-box"><EmptyState icon="receipt" title="No sales yet">Sales made on this till show here.</EmptyState></div>
        <div className="card gallery-box gallery-col"><Skeleton height="1.5rem" width="60%" /><Skeleton height="4rem" /><Skeleton height="4rem" /></div>
      </Section>

      <Section title="Table states">
        <div className="gallery-tables">
          {TABLE_STATES.map((s) => (
            <div key={s} className="gallery-table"><TableShape shape="square" state={s} name="12" seats={4} party={3} server="RO" minutes={34} total="BZ$56.25" w={140} h={140} /></div>
          ))}
        </div>
      </Section>

      <Section title="Sheet">
        <Button variant="secondary" onClick={() => setSheet(true)}>Open a sheet</Button>
        {sheet && <Sheet title="Choices" onClose={() => setSheet(false)} footer={<Button variant="primary" size="lg" onClick={() => setSheet(false)}>Add · BZ$1.69</Button>}><p>A bottom sheet on a phone, a dialog on a till.</p></Sheet>}
      </Section>

      <Section title="Icons">
        <div className="gallery-icons">{(Object.keys(PosIcon) as PosIconName[]).map((n) => <span key={n}><Icon name={n} /><code>{n}</code></span>)}</div>
      </Section>
    </div>
  );
}
