/** A store's site, as the server keeps it (src/commerce/site.ts and site-schema.ts). */

export type LinkType = 'home' | 'catalog' | 'collections' | 'collection' | 'page' | 'product' | 'category' | 'gift_card' | 'account' | 'url';
export interface SiteLink { type: LinkType; value?: string }

export interface Theme {
  preset: string;
  colors: { background: string; surface: string; text: string; primary: string; primaryText: string; accent: string };
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

export interface Block { id: string; settings: Record<string, unknown> }
export interface Section { id: string; type: string; hidden: boolean; settings: Record<string, unknown>; blocks: Block[] }
export interface MenuItem { id: string; label: string; link: SiteLink; children: MenuItem[] }
export interface SitePage { id: string; slug: string; title: string; seoTitle: string; seoDescription: string; sections: Section[] }

export interface SiteDoc {
  version: 1;
  theme: Theme;
  header: { announcement: { enabled: boolean; text: string; link: SiteLink | null; style: 'primary' | 'accent' | 'dark' }; menu: MenuItem[]; sticky: boolean; showSearch: boolean };
  footer: { columns: Array<{ id: string; title: string; links: MenuItem[] }>; text: string; showSocial: boolean; showContact: boolean; showPayments: boolean };
  social: { facebook: string; instagram: string; tiktok: string; youtube: string; x: string };
  seo: { title: string; description: string; image: string };
  home: { sections: Section[] };
  product: { sections: Section[]; showRelated: boolean; relatedTitle: string };
  pages: SitePage[];
  /** Sections kept to reuse on any page (the editor's "Saved sections"); never shown to customers. */
  saved?: Array<{ id: string; name: string; section: Section }>;
}

// ---------- the builder's catalog (from GET /v1/store-site) ----------

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
  showIf?: { key: string; in: unknown[] };
}

export interface SectionSchema {
  type: string;
  name: string;
  description: string;
  icon: string;
  fields: Field[];
  blocks?: { name: string; label: string; max: number; fields: Field[] };
  pages?: Array<'home' | 'page' | 'product'>;
}

export interface Builder {
  sections: SectionSchema[];
  presets: Array<{ key: string; name: string; description: string; theme: Theme }>;
  fonts: Array<{ key: string; name: string; family: string; kind: 'sans' | 'serif' | 'display' }>;
  icons: string[];
  linkTypes: LinkType[];
  themeOptions: Record<string, readonly string[]>;
  categories: string[];
  collections: Array<{ handle: string; title: string; published: boolean }>;
}
