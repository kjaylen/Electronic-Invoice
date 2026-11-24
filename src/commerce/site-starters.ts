/**
 * Ready-made sites and pages for the site builder, so nobody starts from an
 * empty page: a starting site is a whole home page, an About, a Contact and a
 * Questions page, a menu and a footer, written for a kind of business and
 * filled in with the store's own name and tagline; a page template is one
 * page (About us, Contact, Questions, Delivery and returns).
 *
 * They are built from the same section definitions as everything else and go
 * through normalizeSite, so a starting site is always a valid one. The editor
 * applies them to the draft (one step of undo); nothing reaches customers
 * until it is published.
 */

import { PRESET_BY_KEY } from './site-schema.ts';
import { type MenuItem, newId, newSection, normalizeSite, type Section, type SiteDoc, SiteError, type SitePage } from './site.ts';

export interface StarterFacts { name: string; tagline: string; about: string; city: string; accounts: boolean }

type Blocks = Array<Record<string, unknown>>;
/** A section of a type, its defaults changed by `settings` (and `blocks`, replacing the starting ones). */
function section(type: string, settings: Record<string, unknown> = {}, blocks?: Blocks): Section {
  const s = newSection(type);
  return { ...s, settings: { ...s.settings, ...settings }, ...(blocks && { blocks: blocks.map((b) => ({ id: newId(), settings: b })) }) };
}
const page = (slug: string, title: string, sections: Section[], seoDescription = ''): Omit<SitePage, 'id'> => ({ slug, title, seoTitle: '', seoDescription, sections });
const link = (label: string, type: string, value?: string): Omit<MenuItem, 'id'> => ({ label, link: { type, ...(value && { value }) } as MenuItem['link'], children: [] });

// ---------- pages ----------

export interface PageTemplate { key: string; name: string; description: string; title: string }

export const PAGE_TEMPLATES: PageTemplate[] = [
  { key: 'blank', name: 'Blank page', description: 'An empty page to fill with any sections.', title: '' },
  { key: 'about', name: 'About us', description: 'Your story, a picture and what you stand for.', title: 'About us' },
  { key: 'contact', name: 'Contact', description: 'Where you are, opening hours and a form to write to you.', title: 'Contact' },
  { key: 'faq', name: 'Questions and answers', description: 'The questions customers ask most, answered.', title: 'Questions and answers' },
  { key: 'delivery', name: 'Delivery and returns', description: 'How orders reach customers, and what happens if something is wrong.', title: 'Delivery and returns' },
];

function pageSections(key: string, f: StarterFacts): Section[] {
  const where = f.city ? ` in ${f.city}` : '';
  switch (key) {
    case 'about':
      return [
        section('image_with_text', {
          heading: `About ${f.name}`,
          text: f.about || `${f.name} is a Belizean business${where}. Tell customers how you started, who is behind the counter and what makes your products worth coming back for.\n\nA photo of you, your team or your shop on the left makes this page yours.`,
          buttonLabel: 'See our products', buttonLink: { type: 'catalog' },
        }),
        section('highlights', { title: 'What we stand for' }, [
          { icon: 'heart', title: 'Chosen with care', text: 'We only sell what we would buy ourselves.' },
          { icon: 'leaf', title: 'Local first', text: 'We work with Belizean makers and suppliers wherever we can.' },
          { icon: 'chat', title: 'Here to help', text: 'A question before or after you buy? Message us any time.' },
        ]),
      ];
    case 'contact':
      return [
        section('visit_us', { title: 'Find us' }),
        section('contact_form', { title: 'Write to us', text: 'Questions about an order, a product or a special request? Send a message and we will reply by email.' }),
      ];
    case 'faq':
      return [section('faq', { title: 'Questions and answers', text: 'Not here? Message us and we will answer.' }, [
        { question: 'Do you deliver?', answer: 'Yes. Choose delivery at checkout and pick your area; the fee shows before you pay. You can also pick up from us.' },
        { question: 'How can I pay?', answer: 'By bank transfer, in cash on delivery or at pickup, or online where it is offered at checkout.' },
        { question: 'Do I get a receipt?', answer: 'Yes: an official receipt authorized by the Belize Tax Service, sent once your payment is confirmed.' },
        { question: 'How long does an order take?', answer: 'Most orders are ready within one or two working days. We message you when yours is on its way or ready to collect.' },
        { question: 'Can I return something?', answer: 'If something arrives damaged or is not what you ordered, tell us within 7 days and we will put it right.' },
      ])];
    case 'delivery':
      return [
        section('rich_text', {
          heading: 'Delivery and returns', width: 'narrow',
          text: '### Delivery\n\nWe deliver to the areas listed at checkout; the fee for your area shows before you pay. Orders are usually on their way within one or two working days, and we message you when yours leaves.\n\n### Pickup\n\nPrefer to collect? Choose pickup at checkout and we will tell you when your order is ready.\n\n### Returns\n\nIf something arrives damaged or is not what you ordered, tell us within 7 days with your order number. We will replace it or refund you.\n\n- Items must be unused and in their packaging.\n- Food and made-to-order items cannot be returned unless faulty.',
        }),
      ];
    default:
      return [];
  }
}

/** A new page from a template: its title and sections (the editor gives it an address). */
export function pageFromTemplate(key: string, f: StarterFacts): { title: string; sections: Section[] } {
  const template = PAGE_TEMPLATES.find((p) => p.key === key);
  if (!template) throw new SiteError('invalid_site', `There is no page template called ${key}`);
  return { title: template.title, sections: pageSections(key, f) };
}

// ---------- sites ----------

export interface Starter { key: string; name: string; description: string; preset: string; includes: string[] }

export const STARTERS: Starter[] = [
  { key: 'shop', name: 'Shop', description: 'For most stores: a welcoming banner, your newest products, why to buy from you and where to find you.', preset: 'classic', includes: ['Home page', 'About us', 'Contact', 'Questions and answers'] },
  { key: 'food', name: 'Food and drink', description: 'For bakeries, kitchens, groceries and farms: favourites up front, opening hours and how to order.', preset: 'market', includes: ['Home page', 'About us', 'Contact', 'Questions and answers'] },
  { key: 'boutique', name: 'Boutique', description: 'For clothing, crafts and gifts: big pictures, new arrivals and your story.', preset: 'boutique', includes: ['Home page', 'About us', 'Contact', 'Delivery and returns'] },
  { key: 'simple', name: 'One simple page', description: 'Everything on the home page: your products, where you are and a way to write to you.', preset: 'fresh', includes: ['Home page'] },
];

function home(key: string, f: StarterFacts): Section[] {
  const tagline = f.tagline || 'Good things, delivered or ready for pickup.';
  switch (key) {
    case 'food':
      return [
        section('hero', { heading: f.name, text: f.tagline || 'Made fresh, every day.', buttonLabel: 'Order now', buttonLink: { type: 'catalog' }, button2Label: 'Opening hours', button2Link: { type: 'page', value: 'contact' }, height: 'medium', showPerks: true }),
        section('banner', { text: 'Order before 10 am for delivery the same day', buttonLabel: '', background: 'accent' }),
        section('featured_products', { title: 'Favourites', source: 'best_selling', limit: 4, columns: 4 }),
        section('highlights', { title: '' }, [
          { icon: 'sun', title: 'Made fresh', text: 'Prepared the day you order.' },
          { icon: 'leaf', title: 'Local ingredients', text: 'From Belizean farms and markets.' },
          { icon: 'truck', title: 'Delivery or pickup', text: 'Choose what suits you at checkout.' },
        ]),
        section('featured_products', { title: 'New this week', source: 'newest', limit: 4, columns: 4 }),
        section('visit_us', { title: 'Come by' }),
      ];
    case 'boutique':
      return [
        section('hero', { heading: f.name, text: tagline, buttonLabel: 'Shop new arrivals', buttonLink: { type: 'catalog' }, align: 'center', height: 'large', showPerks: false }),
        section('featured_products', { title: 'New arrivals', source: 'newest', limit: 4, columns: 4 }),
        section('image_with_text', { heading: 'Our story', text: f.about || 'Every piece is chosen by hand. Tell customers where your products come from and why you love them.', buttonLabel: 'About us', buttonLink: { type: 'page', value: 'about' }, imagePosition: 'right', background: 'soft' }),
        section('collection_list', { title: 'Shop by collection' }),
        section('testimonials', { title: 'Kind words' }, [
          { quote: 'Beautiful things and lovely service. My order was wrapped like a gift.', author: 'A happy customer', detail: '' },
          { quote: 'I always find something special here.', author: 'A regular', detail: '' },
        ]),
        section('highlights', { title: '' }, [
          { icon: 'gift', title: 'Gift cards', text: 'The easy present, in any amount.' },
          { icon: 'truck', title: 'Delivery or pickup', text: 'Choose what suits you at checkout.' },
          { icon: 'receipt', title: 'Official receipts', text: 'Authorized by the Belize Tax Service.' },
        ]),
      ];
    case 'simple':
      return [
        section('hero', { heading: f.name, text: tagline, buttonLabel: '', height: 'small', showPerks: true }),
        section('product_grid', { title: 'Our products' }),
        section('visit_us', { title: 'Find us' }),
        section('contact_form', { title: 'Write to us' }),
      ];
    default:
      return [
        section('hero', { heading: f.name, text: tagline, buttonLabel: 'Shop now', buttonLink: { type: 'catalog' }, button2Label: 'About us', button2Link: { type: 'page', value: 'about' }, height: 'medium', showPerks: true }),
        section('featured_products', { title: 'New arrivals', source: 'newest', limit: 8, columns: 4 }),
        section('highlights', { title: 'Why shop with us' }),
        section('image_with_text', { heading: 'Our story', text: f.about || 'Tell customers who you are, where your products come from and why they will love them.', buttonLabel: 'About us', buttonLink: { type: 'page', value: 'about' }, background: 'soft' }),
        section('featured_products', { title: 'On sale', source: 'on_sale', limit: 4, columns: 4 }),
        section('visit_us', { title: 'Visit us' }),
      ];
  }
}

/**
 * A starting site for a store, laid over the site it has now: the home page, menu, footer and look
 * are the starter's; the store's logo, tab icon, social links, search text, sections under products
 * and its own pages stay (a starter page is only added where no page has its address yet).
 */
export function starterSite(key: string, f: StarterFacts, current: SiteDoc): SiteDoc {
  const starter = STARTERS.find((s) => s.key === key);
  if (!starter) throw new SiteError('invalid_site', `There is no starting site called ${key}`);
  const wanted = key === 'simple' ? [] : key === 'boutique' ? ['about', 'contact', 'delivery'] : ['about', 'contact', 'faq'];
  const slugs: Record<string, string> = { about: 'about', contact: 'contact', faq: 'questions', delivery: 'delivery-and-returns' };
  const added = wanted.filter((k) => !current.pages.some((p) => p.slug === slugs[k])).map((k) => page(slugs[k]!, PAGE_TEMPLATES.find((t) => t.key === k)!.title, pageSections(k, f)));
  const pageLinks = wanted.map((k) => link(k === 'faq' ? 'Questions' : PAGE_TEMPLATES.find((t) => t.key === k)!.title, 'page', slugs[k]));
  // The business's own home section (Settings → Templates) keeps its place if the site showed it.
  const template = current.home.sections.some((s) => s.type === 'template_section') ? [section('template_section')] : [];
  const sections = home(key, f);
  const theme = PRESET_BY_KEY.get(starter.preset)!.theme;
  return normalizeSite({
    ...current,
    theme: { ...theme, logo: current.theme.logo, logoHeight: current.theme.logoHeight, favicon: current.theme.favicon },
    header: { ...current.header, menu: [link('Home', 'home'), link('Shop', 'catalog'), ...pageLinks.filter((l) => l.label !== 'Questions' && l.label !== 'Delivery and returns')], showSearch: true },
    footer: {
      ...current.footer,
      text: current.footer.text || f.about,
      columns: [
        { title: 'Shop', links: [link('All products', 'catalog'), link('Gift card balance', 'gift_card'), ...(f.accounts ? [link('My account', 'account')] : [])] },
        ...(pageLinks.length ? [{ title: 'Help', links: pageLinks }] : []),
      ],
    },
    home: { sections: [sections[0]!, ...template, ...sections.slice(1)] },
    pages: [...current.pages, ...added],
  });
}
