/**
 * What a store's site is made of, for the site builder: the section types a
 * page can hold (each with its fields and repeatable blocks), the theme
 * presets and fonts, and the links a menu or a button can point to.
 *
 * The editor builds its forms from these definitions (served with the site),
 * and the server checks every saved site against them (site.ts), so the two
 * never disagree about what a section may contain.
 */

export type FieldType =
  | 'text' | 'textarea' | 'richtext' | 'select' | 'number' | 'toggle' | 'image' | 'images'
  | 'link' | 'collection' | 'collections' | 'products' | 'category' | 'datetime' | 'code' | 'icon';

export interface Field {
  key: string;
  type: FieldType;
  label: string;
  hint?: string;
  options?: Array<[string, string]>;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  maxItems?: number;
  default?: unknown;
  /** Shown only when another field has one of these values. */
  showIf?: { key: string; in: unknown[] };
}

export interface BlockSchema { name: string; label: string; max: number; fields: Field[] }

export type PageKind = 'home' | 'page' | 'product';

export interface SectionSchema {
  type: string;
  name: string;
  description: string;
  icon: string;
  fields: Field[];
  blocks?: BlockSchema;
  /** Where it may be added (all pages when left out). */
  pages?: PageKind[];
  /** Starting blocks when added. */
  defaultBlocks?: Array<Record<string, unknown>>;
}

export const ICONS = ['truck', 'store', 'receipt', 'leaf', 'star', 'heart', 'shield', 'clock', 'gift', 'phone', 'chat', 'tag', 'sparkle', 'check', 'map', 'card', 'sun', 'wave'] as const;

export const LINK_TYPES = ['home', 'catalog', 'collections', 'collection', 'page', 'product', 'category', 'gift_card', 'account', 'url'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export interface SiteLink { type: LinkType; value?: string }

/** What a picture shows, for people who cannot see it and for search engines (shown only once there is a picture). */
const imageAlt: Field = { key: 'imageAlt', type: 'text', label: 'Describe the picture', hint: 'For people who cannot see it, and for search engines. Leave empty if it is only decoration.', maxLength: 160, default: '', showIf: { key: 'image', in: ['*'] } };
const background: Field = { key: 'background', type: 'select', label: 'Background', options: [['none', 'None'], ['soft', 'Soft tint'], ['primary', 'Brand colour'], ['dark', 'Dark']], default: 'none' };
const align: Field = { key: 'align', type: 'select', label: 'Alignment', options: [['left', 'Left'], ['center', 'Centre']], default: 'left' };
const button = (n = ''): Field[] => [
  { key: `button${n}Label`, type: 'text', label: n ? 'Second button text' : 'Button text', maxLength: 40, default: '' },
  { key: `button${n}Link`, type: 'link', label: n ? 'Second button link' : 'Button link', default: { type: 'catalog' } },
];
const columns = (min: number, max: number, def: number): Field => ({ key: 'columns', type: 'number', label: 'Columns on a computer', min, max, step: 1, default: def });

export const SECTIONS: SectionSchema[] = [
  {
    type: 'hero', name: 'Banner', icon: 'image', description: 'A large opening section: a picture, a headline and buttons.',
    fields: [
      { key: 'image', type: 'image', label: 'Picture', hint: 'Wide pictures work best (at least 1600 pixels across).', default: '' },
      imageAlt,
      { key: 'focus', type: 'select', label: 'Keep in view', options: [['center', 'Middle'], ['top', 'Top'], ['bottom', 'Bottom']], default: 'center', showIf: { key: 'image', in: ['*'] } },
      { key: 'heading', type: 'text', label: 'Headline', maxLength: 120, default: 'Welcome to our store' },
      { key: 'text', type: 'textarea', label: 'Text', maxLength: 400, default: 'Fresh picks every week, delivered or ready for pickup.' },
      ...button(), ...button('2'),
      align,
      { key: 'height', type: 'select', label: 'Height', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], default: 'medium' },
      { key: 'overlay', type: 'number', label: 'Darken the picture (%)', min: 0, max: 80, step: 10, default: 30, showIf: { key: 'image', in: ['*'] } },
      { key: 'showPerks', type: 'toggle', label: 'Show delivery and pickup', default: false },
    ],
  },
  {
    type: 'banner', name: 'Promotion strip', icon: 'tag', description: 'A slim coloured strip with a short message and a button.',
    fields: [
      { key: 'text', type: 'text', label: 'Message', maxLength: 160, default: 'Free delivery in town on orders over BZ$100' },
      ...button(),
      { key: 'background', type: 'select', label: 'Colour', options: [['primary', 'Brand colour'], ['accent', 'Accent colour'], ['dark', 'Dark'], ['soft', 'Soft tint']], default: 'primary' },
    ],
  },
  {
    type: 'product_grid', name: 'All products', icon: 'grid', description: 'Every product for sale, with search and categories.',
    fields: [
      { key: 'title', type: 'text', label: 'Title', maxLength: 80, default: '' },
      { key: 'source', type: 'select', label: 'Products', options: [['all', 'Everything for sale'], ['collection', 'One collection']], default: 'all' },
      { key: 'collection', type: 'collection', label: 'Collection', default: '', showIf: { key: 'source', in: ['collection'] } },
      { key: 'sort', type: 'select', label: 'Order', options: [['newest', 'Newest first'], ['price_asc', 'Price, low to high'], ['price_desc', 'Price, high to low'], ['title', 'Name, A to Z'], ['best_selling', 'Best selling']], default: 'newest' },
      { key: 'showSearch', type: 'toggle', label: 'Search box', default: true },
      { key: 'showCategories', type: 'toggle', label: 'Category buttons', default: true },
      columns(2, 5, 4),
    ],
  },
  {
    type: 'featured_products', name: 'Featured products', icon: 'star', description: 'A row of products: newest, on sale, a collection, a category, or ones you pick.',
    fields: [
      { key: 'title', type: 'text', label: 'Title', maxLength: 80, default: 'New arrivals' },
      { key: 'text', type: 'textarea', label: 'Text', maxLength: 300, default: '' },
      { key: 'source', type: 'select', label: 'Products', options: [['newest', 'Newest'], ['on_sale', 'On sale'], ['best_selling', 'Best selling'], ['collection', 'A collection'], ['category', 'A category'], ['manual', 'Ones I pick']], default: 'newest' },
      { key: 'collection', type: 'collection', label: 'Collection', default: '', showIf: { key: 'source', in: ['collection'] } },
      { key: 'category', type: 'category', label: 'Category', default: '', showIf: { key: 'source', in: ['category'] } },
      { key: 'products', type: 'products', label: 'Products', maxItems: 12, default: [], showIf: { key: 'source', in: ['manual'] } },
      { key: 'limit', type: 'number', label: 'How many', min: 2, max: 12, step: 1, default: 4, showIf: { key: 'source', in: ['newest', 'on_sale', 'best_selling', 'collection', 'category'] } },
      columns(2, 5, 4),
      { key: 'showViewAll', type: 'toggle', label: '“View all” link', default: true },
    ],
  },
  {
    type: 'collection_list', name: 'Collections', icon: 'folder', description: 'Tiles for your collections, each opening its own page.',
    fields: [
      { key: 'title', type: 'text', label: 'Title', maxLength: 80, default: 'Shop by collection' },
      { key: 'collections', type: 'collections', label: 'Collections', hint: 'Leave empty to show them all.', maxItems: 12, default: [] },
      columns(2, 4, 3),
    ],
  },
  {
    type: 'image_with_text', name: 'Picture with text', icon: 'split', description: 'A picture beside a heading, text and a button.',
    fields: [
      { key: 'image', type: 'image', label: 'Picture', default: '' },
      imageAlt,
      { key: 'heading', type: 'text', label: 'Heading', maxLength: 120, default: 'Our story' },
      { key: 'text', type: 'richtext', label: 'Text', maxLength: 3000, default: 'Tell customers who you are, where your products come from and why they will love them.' },
      ...button(),
      { key: 'imagePosition', type: 'select', label: 'Picture on the', options: [['left', 'Left'], ['right', 'Right']], default: 'left' },
      background,
    ],
  },
  {
    type: 'rich_text', name: 'Text', icon: 'text', description: 'A heading and paragraphs: an announcement, a story, a policy.',
    fields: [
      { key: 'heading', type: 'text', label: 'Heading', maxLength: 120, default: 'Made with care in Belize' },
      { key: 'text', type: 'richtext', label: 'Text', maxLength: 8000, default: 'Write anything here. Use **bold**, *italics*, [links](https://example.com) and lists starting with “- ”.' },
      ...button(),
      align,
      { key: 'width', type: 'select', label: 'Width', options: [['narrow', 'Narrow'], ['normal', 'Normal']], default: 'narrow' },
      background,
    ],
  },
  {
    type: 'columns', name: 'Columns', icon: 'columns', description: 'Two to four columns, each with a picture, a heading, text and a link.',
    fields: [{ key: 'title', type: 'text', label: 'Title', maxLength: 80, default: '' }, background],
    blocks: {
      name: 'column', label: 'Column', max: 6,
      fields: [
        { key: 'image', type: 'image', label: 'Picture', default: '' },
        imageAlt,
        { key: 'heading', type: 'text', label: 'Heading', maxLength: 80, default: 'Column' },
        { key: 'text', type: 'richtext', label: 'Text', maxLength: 1000, default: '' },
        { key: 'linkLabel', type: 'text', label: 'Link text', maxLength: 40, default: '' },
        { key: 'link', type: 'link', label: 'Link', default: { type: 'catalog' } },
      ],
    },
    defaultBlocks: [{ heading: 'Fresh', text: 'Picked this morning.' }, { heading: 'Local', text: 'From farms in Cayo and Toledo.' }, { heading: 'Delivered', text: 'To your door in town.' }],
  },
  {
    type: 'highlights', name: 'Highlights', icon: 'sparkle', description: 'Short reasons to buy, each with an icon: free delivery, BTS receipts, local.',
    fields: [{ key: 'title', type: 'text', label: 'Title', maxLength: 80, default: '' }, background],
    blocks: {
      name: 'highlight', label: 'Highlight', max: 8,
      fields: [
        { key: 'icon', type: 'icon', label: 'Icon', default: 'check' },
        { key: 'title', type: 'text', label: 'Title', maxLength: 60, default: 'Highlight' },
        { key: 'text', type: 'textarea', label: 'Text', maxLength: 200, default: '' },
      ],
    },
    defaultBlocks: [
      { icon: 'truck', title: 'Delivery or pickup', text: 'Choose what suits you at checkout.' },
      { icon: 'receipt', title: 'Official receipts', text: 'Every purchase comes with a receipt authorized by the Belize Tax Service.' },
      { icon: 'chat', title: 'Real people', text: 'Questions? Message us on WhatsApp.' },
    ],
  },
  {
    type: 'testimonials', name: 'Testimonials', icon: 'quote', description: 'What customers say about you.',
    fields: [{ key: 'title', type: 'text', label: 'Title', maxLength: 80, default: 'What customers say' }, background],
    blocks: {
      name: 'testimonial', label: 'Testimonial', max: 12,
      fields: [
        { key: 'quote', type: 'textarea', label: 'Quote', maxLength: 500, default: 'Great service and lovely products.' },
        { key: 'author', type: 'text', label: 'Name', maxLength: 60, default: 'A happy customer' },
        { key: 'detail', type: 'text', label: 'Detail', hint: 'A town, or what they bought.', maxLength: 60, default: '' },
      ],
    },
    defaultBlocks: [{ quote: 'Always fresh and always on time.', author: 'Maria', detail: 'Belize City' }, { quote: 'The best in San Ignacio, hands down.', author: 'Jorge', detail: 'San Ignacio' }],
  },
  {
    type: 'faq', name: 'Questions and answers', icon: 'help', description: 'Questions customers ask, answered (each opens on a click).',
    fields: [{ key: 'title', type: 'text', label: 'Title', maxLength: 80, default: 'Questions and answers' }, { key: 'text', type: 'textarea', label: 'Text', maxLength: 300, default: '' }],
    blocks: {
      name: 'question', label: 'Question', max: 40,
      fields: [
        { key: 'question', type: 'text', label: 'Question', maxLength: 200, default: 'Do you deliver?' },
        { key: 'answer', type: 'richtext', label: 'Answer', maxLength: 3000, default: 'Yes: choose delivery at checkout and pick your area.' },
      ],
    },
    defaultBlocks: [
      { question: 'Do you deliver?', answer: 'Yes: choose delivery at checkout and pick your area.' },
      { question: 'How can I pay?', answer: 'By bank transfer, in cash on delivery or at pickup, or online where offered.' },
      { question: 'Do I get a receipt?', answer: 'Yes, an official receipt authorized by the Belize Tax Service, once your payment is confirmed.' },
    ],
  },
  {
    type: 'gallery', name: 'Gallery', icon: 'photos', description: 'A grid of pictures.',
    fields: [
      { key: 'title', type: 'text', label: 'Title', maxLength: 80, default: '' },
      { key: 'images', type: 'images', label: 'Pictures', maxItems: 24, default: [] },
      columns(2, 6, 3),
      { key: 'aspect', type: 'select', label: 'Shape', options: [['square', 'Square'], ['portrait', 'Tall'], ['landscape', 'Wide'], ['natural', 'As uploaded']], default: 'square' },
    ],
  },
  {
    type: 'logo_list', name: 'Logos', icon: 'badge', description: 'A row of logos: brands you carry, partners, awards.',
    fields: [{ key: 'title', type: 'text', label: 'Title', maxLength: 80, default: 'Brands we carry' }, { key: 'images', type: 'images', label: 'Logos', maxItems: 24, default: [] }],
  },
  {
    type: 'video', name: 'Video', icon: 'play', description: 'A YouTube or Vimeo video.',
    fields: [
      { key: 'title', type: 'text', label: 'Title', maxLength: 80, default: '' },
      { key: 'url', type: 'text', label: 'Video address', hint: 'A YouTube or Vimeo link.', maxLength: 300, default: '' },
      { key: 'caption', type: 'text', label: 'Caption', maxLength: 200, default: '' },
    ],
  },
  {
    type: 'countdown', name: 'Countdown', icon: 'clock', description: 'Days, hours and minutes left in a sale or until an event.',
    fields: [
      { key: 'heading', type: 'text', label: 'Heading', maxLength: 120, default: 'Weekend sale ends in' },
      { key: 'text', type: 'textarea', label: 'Text', maxLength: 300, default: '' },
      { key: 'endsAt', type: 'datetime', label: 'Ends', default: '' },
      ...button(),
      { key: 'endedText', type: 'text', label: 'Once it ends, say', hint: 'Leave empty to hide the section when it ends.', maxLength: 160, default: '' },
      { key: 'background', type: 'select', label: 'Colour', options: [['primary', 'Brand colour'], ['accent', 'Accent colour'], ['dark', 'Dark'], ['soft', 'Soft tint']], default: 'dark' },
    ],
  },
  {
    type: 'visit_us', name: 'Visit us', icon: 'map', description: 'Where you are, opening hours, and buttons to call, message or get directions.',
    fields: [
      { key: 'title', type: 'text', label: 'Title', maxLength: 80, default: 'Visit us' },
      { key: 'address', type: 'textarea', label: 'Address', hint: 'Leave empty to use your business address.', maxLength: 300, default: '' },
      { key: 'image', type: 'image', label: 'Picture of the shop', default: '' },
      imageAlt,
      { key: 'showDirections', type: 'toggle', label: 'Directions button (Google Maps)', default: true },
      { key: 'showCall', type: 'toggle', label: 'Call button', default: true },
      { key: 'showWhatsapp', type: 'toggle', label: 'WhatsApp button', default: true },
    ],
    blocks: {
      name: 'hours', label: 'Opening hours', max: 7,
      fields: [{ key: 'days', type: 'text', label: 'Days', maxLength: 40, default: 'Monday to Friday' }, { key: 'hours', type: 'text', label: 'Hours', maxLength: 40, default: '8 am to 5 pm' }],
    },
    defaultBlocks: [{ days: 'Monday to Friday', hours: '8 am to 5 pm' }, { days: 'Saturday', hours: '8 am to 12 noon' }],
  },
  {
    type: 'contact_form', name: 'Contact form', icon: 'mail', description: 'Customers write to you; the message comes to your email.',
    fields: [
      { key: 'title', type: 'text', label: 'Title', maxLength: 80, default: 'Get in touch' },
      { key: 'text', type: 'textarea', label: 'Text', maxLength: 300, default: 'Questions about an order, a product or a custom request? Write to us.' },
      { key: 'buttonLabel', type: 'text', label: 'Button text', maxLength: 40, default: 'Send' },
      { key: 'showPhone', type: 'toggle', label: 'Ask for a phone number', default: true },
    ],
  },
  {
    type: 'template_section', name: 'Custom home section (Templates)', icon: 'code', description: 'The home page section from Settings → Templates, written in HTML and Liquid.',
    fields: [], pages: ['home'],
  },
  {
    type: 'custom_code', name: 'Custom HTML', icon: 'code', description: 'Your own HTML and Liquid. Scripts are removed.',
    fields: [{ key: 'code', type: 'code', label: 'HTML and Liquid', maxLength: 20000, default: '<div style="text-align:center;padding:2rem">\n  <h2>{{ store.name }}</h2>\n</div>' }],
  },
  {
    type: 'spacer', name: 'Space', icon: 'space', description: 'Breathing room between sections, with an optional line.',
    fields: [
      { key: 'size', type: 'select', label: 'Size', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], default: 'medium' },
      { key: 'divider', type: 'toggle', label: 'Line', default: false },
    ],
  },
];

export const SECTION_BY_TYPE = new Map(SECTIONS.map((s) => [s.type, s]));

// ---------- the theme ----------

/** Fonts the storefront ships with (served from the app; nothing loads from elsewhere). */
export const FONTS: Array<{ key: string; name: string; family: string; kind: 'sans' | 'serif' | 'display' }> = [
  { key: 'inter', name: 'Inter', family: "'Inter Variable', 'Inter', system-ui, sans-serif", kind: 'sans' },
  { key: 'inter-tight', name: 'Inter Tight', family: "'Inter Tight Variable', 'Inter Variable', system-ui, sans-serif", kind: 'sans' },
  { key: 'dm-sans', name: 'DM Sans', family: "'DM Sans Variable', system-ui, sans-serif", kind: 'sans' },
  { key: 'montserrat', name: 'Montserrat', family: "'Montserrat Variable', system-ui, sans-serif", kind: 'sans' },
  { key: 'nunito', name: 'Nunito', family: "'Nunito Variable', system-ui, sans-serif", kind: 'sans' },
  { key: 'outfit', name: 'Outfit', family: "'Outfit Variable', system-ui, sans-serif", kind: 'sans' },
  { key: 'space-grotesk', name: 'Space Grotesk', family: "'Space Grotesk Variable', system-ui, sans-serif", kind: 'sans' },
  { key: 'playfair', name: 'Playfair Display', family: "'Playfair Display Variable', Georgia, serif", kind: 'serif' },
  { key: 'fraunces', name: 'Fraunces', family: "'Fraunces Variable', Georgia, serif", kind: 'serif' },
  { key: 'lora', name: 'Lora', family: "'Lora Variable', Georgia, serif", kind: 'serif' },
  { key: 'dm-serif', name: 'DM Serif Display', family: "'DM Serif Display', Georgia, serif", kind: 'display' },
];
export const FONT_KEYS = new Set(FONTS.map((f) => f.key));

export interface ThemeColors { background: string; surface: string; text: string; primary: string; primaryText: string; accent: string }
export interface Theme {
  preset: string;
  colors: ThemeColors;
  fonts: { heading: string; body: string };
  radius: 'none' | 'small' | 'medium' | 'large';
  buttons: 'solid' | 'outline' | 'pill';
  cards: 'plain' | 'bordered' | 'shadow';
  imageShape: 'square' | 'portrait' | 'landscape';
  width: 'narrow' | 'normal' | 'wide';
  spacing: 'compact' | 'normal' | 'airy';
  headerLayout: 'left' | 'center';
  headerStyle: 'light' | 'brand' | 'dark';
  headingCase: 'normal' | 'upper';
  logo: string;
  logoHeight: number;
  favicon: string;
}

export const THEME_OPTIONS = {
  radius: ['none', 'small', 'medium', 'large'],
  buttons: ['solid', 'outline', 'pill'],
  cards: ['plain', 'bordered', 'shadow'],
  imageShape: ['square', 'portrait', 'landscape'],
  width: ['narrow', 'normal', 'wide'],
  spacing: ['compact', 'normal', 'airy'],
  headerLayout: ['left', 'center'],
  headerStyle: ['light', 'brand', 'dark'],
  headingCase: ['normal', 'upper'],
} as const;

const theme = (preset: string, colors: ThemeColors, fonts: [string, string], rest: Partial<Theme>): Theme => ({
  preset, colors, fonts: { heading: fonts[0], body: fonts[1] }, radius: 'medium', buttons: 'solid', cards: 'plain', imageShape: 'square',
  width: 'normal', spacing: 'normal', headerLayout: 'left', headerStyle: 'light', headingCase: 'normal', logo: '', logoHeight: 40, favicon: '', ...rest,
});

/** Starting looks: pick one, then change anything. */
export const PRESETS: Array<{ key: string; name: string; description: string; theme: Theme }> = [
  { key: 'classic', name: 'Classic', description: 'Clean and bright, in Floreo purple.', theme: theme('classic', { background: '#ffffff', surface: '#f8f9fa', text: '#0f1117', primary: '#6d2d93', primaryText: '#ffffff', accent: '#11703a' }, ['inter-tight', 'inter'], {}) },
  { key: 'boutique', name: 'Boutique', description: 'Warm ivory, elegant serif headings, tall pictures.', theme: theme('boutique', { background: '#faf7f2', surface: '#f2ece2', text: '#2b2622', primary: '#2b2622', primaryText: '#faf7f2', accent: '#9a6b2f' }, ['dm-serif', 'dm-sans'], { radius: 'none', imageShape: 'portrait', headerLayout: 'center', spacing: 'airy', headingCase: 'normal' }) },
  { key: 'fresh', name: 'Fresh', description: 'Green and friendly, rounded and soft.', theme: theme('fresh', { background: '#ffffff', surface: '#f1f8f3', text: '#16241b', primary: '#1f7a4d', primaryText: '#ffffff', accent: '#c2410c' }, ['nunito', 'nunito'], { radius: 'large', buttons: 'pill', cards: 'bordered' }) },
  { key: 'island', name: 'Island', description: 'Caribbean teal and sunset coral.', theme: theme('island', { background: '#f6fbfb', surface: '#e8f4f4', text: '#0f2a2e', primary: '#0e7490', primaryText: '#ffffff', accent: '#c2410c' }, ['montserrat', 'lora'], { radius: 'large', cards: 'shadow', headerStyle: 'brand' }) },
  { key: 'market', name: 'Market', description: 'Earthy terracotta, a busy shop feel.', theme: theme('market', { background: '#fff8ee', surface: '#f7ecdc', text: '#3a2a1a', primary: '#b3420c', primaryText: '#ffffff', accent: '#15803d' }, ['fraunces', 'inter'], { spacing: 'compact', cards: 'bordered' }) },
  { key: 'bold', name: 'Bold', description: 'Dark and striking, with a bright yellow.', theme: theme('bold', { background: '#111111', surface: '#1c1c1c', text: '#f5f5f5', primary: '#ffd400', primaryText: '#111111', accent: '#ff6b6b' }, ['space-grotesk', 'inter'], { radius: 'small', headerStyle: 'dark', headingCase: 'upper' }) },
  { key: 'minimal', name: 'Minimal', description: 'Black and white, lots of space, outlined buttons.', theme: theme('minimal', { background: '#ffffff', surface: '#f5f5f5', text: '#111111', primary: '#111111', primaryText: '#ffffff', accent: '#be123c' }, ['outfit', 'outfit'], { radius: 'none', buttons: 'outline', spacing: 'airy', width: 'narrow' }) },
];
export const PRESET_BY_KEY = new Map(PRESETS.map((p) => [p.key, p]));
