/**
 * Importing a business's catalog and customers from a spreadsheet. Each row is checked like the
 * forms check it; a dry run reports what would happen row by row, and the import writes the good
 * rows (an item is matched by its code, then its barcode; a customer by TIN, then email) and lists
 * the rest with the reason.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.ts';
import { spelledCategory } from '../inventory/categories.ts';
import { moveStock, stockQuantity } from '../inventory/stock.ts';
import { amount, columns, CsvError, parseCsv, truthy } from './csv.ts';

export interface RowResult { row: number; action: 'create' | 'update' | 'error'; name: string; detail?: string; message?: string }
export interface ImportResult { rows: number; created: number; updated: number; errors: number; results: RowResult[] }

const UNIT_NAMES: Record<string, string> = {
  each: 'EA', ea: 'EA', piece: 'H87', pieces: 'H87', pc: 'H87', pcs: 'H87', unit: 'H87', units: 'H87', item: 'H87',
  box: 'BX', boxes: 'BX', pack: 'PK', packs: 'PK', kg: 'KGM', kilo: 'KGM', kilogram: 'KGM', lb: 'LBR', lbs: 'LBR', pound: 'LBR',
  l: 'LTR', litre: 'LTR', liter: 'LTR', gallon: 'GLL', gal: 'GLL', m: 'MTR', metre: 'MTR', meter: 'MTR', ft: 'FOT', foot: 'FOT', feet: 'FOT',
  hour: 'HUR', hours: 'HUR', hr: 'HUR', day: 'DAY', days: 'DAY', month: 'MON', months: 'MON',
};
const unitCode = (v: string): string | null => {
  const s = v.trim();
  if (!s) return 'H87';
  if (/^[A-Z0-9]{1,3}$/.test(s)) return s;
  return UNIT_NAMES[s.toLowerCase().replace(/\.$/, '')] ?? null;
};
const gstCategory = (v: string): 'S' | 'Z' | 'E' | null => {
  const s = v.trim().toLowerCase().replace(/%$/, '');
  if (!s || ['s', 'standard', '12.5', 'yes', 'y', 'taxable', 'gst'].includes(s)) return 'S';
  if (['z', 'zero', '0', 'zero-rated', 'zero rated', 'zerorated'].includes(s)) return 'Z';
  if (['e', 'exempt', 'no', 'n'].includes(s)) return 'E';
  return null;
};

const ITEM_COLUMNS = {
  name: ['name', 'item', 'itemname', 'product', 'productname', 'title'],
  description: ['description', 'details'],
  code: ['code', 'sku', 'yourcode', 'sellercode', 'itemcode', 'productcode', 'ref', 'reference'],
  barcode: ['barcode', 'upc', 'ean', 'gtin'],
  price: ['price', 'unitprice', 'pricebeforegst', 'netprice', 'priceexclgst', 'priceexgst', 'sellingprice', 'pricewithoutgst'],
  priceWithGst: ['pricewithgst', 'priceinclgst', 'priceincgst', 'priceincludinggst', 'retailprice', 'shelfprice', 'pricegstincluded'],
  gst: ['gst', 'gstcategory', 'gstrate', 'tax', 'taxcategory', 'vat'],
  exemption: ['exemptionreason', 'exemptioncode', 'exemptionreasoncode'],
  unit: ['unit', 'unitcode', 'uom', 'unitofmeasure'],
  stock: ['stock', 'quantity', 'qty', 'onhand', 'instock', 'stockquantity', 'stocklevel'],
  lowStock: ['lowstock', 'reorderlevel', 'reorderpoint', 'minstock', 'minimumstock'],
  favorite: ['quickbutton', 'favorite', 'favourite', 'star', 'starred'],
  wholesale: ['wholesaleprice', 'wholesale', 'tradeprice', 'pricewholesale'],
  category: ['category', 'categoria', 'department', 'group', 'section'],
};

export async function importItems(db: Queryable, tenantId: string, csv: string, options: { dryRun: boolean; userId: string | null }): Promise<ImportResult> {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new CsvError('The file has a header row and no items under it');
  const col = columns(rows[0]!, ITEM_COLUMNS);
  if (col.name === undefined) throw new CsvError('No "Name" column (the item\'s name)');
  if (col.price === undefined && col.priceWithGst === undefined) throw new CsvError('No "Price" column (before GST), or "Price with GST"');
  const existing = (await db.query<{ id: string; seller_code: string | null; barcode: string | null; name: string }>(
    'select id, seller_code, barcode, name from items where tenant_id = $1 and archived_at is null', [tenantId],
  )).rows;
  const byCode = new Map(existing.filter((e) => e.seller_code).map((e) => [e.seller_code!.toLowerCase(), e]));
  const byBarcode = new Map(existing.filter((e) => e.barcode).map((e) => [e.barcode!, e]));
  // A row with neither code nor barcode matches an item by name, when only one item has that name.
  const nameCounts = new Map<string, number>();
  for (const e of existing) nameCounts.set(e.name.toLowerCase(), (nameCounts.get(e.name.toLowerCase()) ?? 0) + 1);
  const byName = new Map(existing.filter((e) => nameCounts.get(e.name.toLowerCase()) === 1).map((e) => [e.name.toLowerCase(), e]));
  const seenCodes = new Set<string>();
  const seenBarcodes = new Set<string>();
  const results: RowResult[] = [];
  const get = (r: string[], k: keyof typeof ITEM_COLUMNS) => (col[k] === undefined ? '' : (r[col[k]!] ?? '').trim());

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const n = i + 1;
    const name = get(r, 'name');
    const fail = (message: string) => results.push({ row: n, action: 'error', name: name || `Row ${n}`, message });
    if (!name) { fail('No name'); continue; }
    if (name.length > 300) { fail('The name is longer than 300 characters'); continue; }
    const gst = gstCategory(get(r, 'gst'));
    if (!gst) { fail(`GST "${get(r, 'gst')}" is not S (standard 12.5%), Z (zero-rated) or E (exempt)`); continue; }
    const exemption = get(r, 'exemption');
    if (gst === 'E' && !exemption) { fail('An exempt item needs an exemption reason code'); continue; }
    let price = get(r, 'price') ? amount(get(r, 'price')) : null;
    if (price === null && get(r, 'priceWithGst')) {
      const withGst = amount(get(r, 'priceWithGst'));
      if (withGst !== null) price = gst === 'S' ? (Math.round((Number(withGst) / 1.125) * 1e6) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : withGst;
    }
    if (price === null) { fail(`"${get(r, 'price') || get(r, 'priceWithGst')}" is not a price`); continue; }
    const wholesale = get(r, 'wholesale') ? amount(get(r, 'wholesale')) : null;
    const category = await spelledCategory(db, tenantId, get(r, 'category'));
    if (get(r, 'wholesale') && wholesale === null) { fail(`Wholesale price "${get(r, 'wholesale')}" is not a price`); continue; }
    const unit = unitCode(get(r, 'unit'));
    if (!unit) { fail(`Unit "${get(r, 'unit')}" is not one we know (each, kg, lb, litre, box, hour…)`); continue; }
    const code = get(r, 'code') || null;
    const barcode = get(r, 'barcode') || null;
    if (code && code.length > 100) { fail('The code is longer than 100 characters'); continue; }
    if (barcode && !/^[0-9A-Za-z-]{1,64}$/.test(barcode)) { fail(`Barcode "${barcode}" has characters a barcode cannot have`); continue; }
    if (code && seenCodes.has(code.toLowerCase())) { fail(`Code ${code} is on an earlier row too`); continue; }
    if (barcode && seenBarcodes.has(barcode)) { fail(`Barcode ${barcode} is on an earlier row too`); continue; }
    let stock: string | null = null;
    let lowStock: string | null = null;
    try {
      if (get(r, 'stock')) stock = stockQuantity(get(r, 'stock').replace(/,/g, ''));
      if (get(r, 'lowStock')) lowStock = stockQuantity(get(r, 'lowStock').replace(/,/g, ''));
    } catch {
      fail('Stock quantities are numbers with up to 3 decimals');
      continue;
    }
    const match = (code && byCode.get(code.toLowerCase())) || (barcode && byBarcode.get(barcode)) || (!code && !barcode && byName.get(name.toLowerCase())) || null;
    // A barcode already on a different item.
    const barcodeOwner = barcode ? byBarcode.get(barcode) : undefined;
    if (barcodeOwner && match && barcodeOwner.id !== match.id) { fail(`Barcode ${barcode} belongs to another item`); continue; }
    if (code) seenCodes.add(code.toLowerCase());
    if (barcode) seenBarcodes.add(barcode);
    const detail = `BZ$${Number(price).toFixed(2)} before GST${stock !== null ? `, ${stock} in stock` : ''}`;
    results.push({ row: n, action: match ? 'update' : 'create', name, detail });
    if (options.dryRun) continue;

    const description = get(r, 'description') || name;
    const favorite = col.favorite !== undefined ? truthy(get(r, 'favorite')) : null;
    let id = match?.id;
    if (match) {
      await db.query(
        `update items set name = $3, description = $4, seller_code = coalesce($5, seller_code), unit_code = $6, unit_price = $7, gst_category = $8,
           exemption_reason_code = $9, barcode = coalesce($10, barcode), favorite = coalesce($11, favorite), wholesale_price = coalesce($12, wholesale_price), category = coalesce($13, category)${lowStock !== null ? ', low_stock = $14' : ''}
         where id = $1 and tenant_id = $2`,
        [match.id, tenantId, name, description, code, unit, price, gst, gst === 'E' ? exemption : null, barcode, favorite, wholesale, category, ...(lowStock !== null ? [lowStock] : [])],
      );
    } else {
      id = randomUUID();
      await db.query(
        `insert into items (id, tenant_id, name, description, seller_code, unit_code, unit_price, gst_category, exemption_reason_code, barcode, favorite, low_stock, wholesale_price, category)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [id, tenantId, name, description, code, unit, price, gst, gst === 'E' ? exemption : null, barcode, favorite ?? false, lowStock, wholesale, category],
      );
      if (code) byCode.set(code.toLowerCase(), { id, seller_code: code, barcode, name });
      if (barcode) byBarcode.set(barcode, { id, seller_code: code, barcode, name });
    }
    // The stock column is a count: it sets the level, through the stock ledger.
    if (stock !== null) await moveStock(db, { tenantId, itemId: id!, quantity: stock, mode: 'set', reason: 'count', startTracking: true, note: 'Imported', userId: options.userId });
  }
  return summarize(rows.length - 1, results);
}

const CUSTOMER_COLUMNS = {
  name: ['name', 'customer', 'customername', 'company', 'companyname', 'businessname', 'client'],
  tin: ['tin', 'taxid', 'taxnumber', 'tinnumber'],
  email: ['email', 'emailaddress', 'mail'],
  phone: ['phone', 'telephone', 'tel', 'mobile', 'cell', 'phonenumber'],
  street: ['street', 'address', 'address1', 'streetaddress', 'addressline1'],
  city: ['city', 'town', 'village'],
  district: ['district', 'districtcode'],
  priceList: ['pricelist', 'pricing', 'customertype', 'type'],
};
const DISTRICTS: Record<string, string> = { belize: '1', cayo: '2', corozal: '3', orangewalk: '4', stanncreek: '5', toledo: '6' };
const districtCode = (v: string): string | null => {
  const s = v.trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/district$/, '');
  if (/^[1-6]$/.test(s)) return s;
  return DISTRICTS[s] ?? null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function importCustomers(db: Queryable, tenantId: string, csv: string, options: { dryRun: boolean }): Promise<ImportResult> {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new CsvError('The file has a header row and no customers under it');
  const col = columns(rows[0]!, CUSTOMER_COLUMNS);
  if (col.name === undefined) throw new CsvError('No "Name" column (the customer\'s name)');
  const existing = (await db.query<{ id: string; tin: string | null; email: string | null }>(
    'select id, tin, email from customers where tenant_id = $1 and archived_at is null', [tenantId],
  )).rows;
  const byTin = new Map(existing.filter((e) => e.tin).map((e) => [e.tin!, e.id]));
  const byEmail = new Map(existing.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e.id]));
  const results: RowResult[] = [];
  const get = (r: string[], k: keyof typeof CUSTOMER_COLUMNS) => (col[k] === undefined ? '' : (r[col[k]!] ?? '').trim());

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    const n = i + 1;
    const name = get(r, 'name');
    const fail = (message: string) => results.push({ row: n, action: 'error', name: name || `Row ${n}`, message });
    if (!name) { fail('No name'); continue; }
    const tin = get(r, 'tin').replace(/\D/g, '') || null;
    if (tin && !/^\d{6}$/.test(tin)) { fail(`TIN "${get(r, 'tin')}" is not 6 digits`); continue; }
    const email = get(r, 'email') || null;
    if (email && !EMAIL.test(email)) { fail(`"${email}" is not an email address`); continue; }
    const street = get(r, 'street') || null;
    const city = get(r, 'city') || null;
    const district = get(r, 'district') ? districtCode(get(r, 'district')) : null;
    if (get(r, 'district') && !district) { fail(`District "${get(r, 'district')}" is not one of Belize, Cayo, Corozal, Orange Walk, Stann Creek or Toledo`); continue; }
    const fullAddress = Boolean(street && city && district);
    const listText = get(r, 'priceList').toLowerCase();
    const priceList = !listText ? null : /^(w|wholesale|trade|mayorista)$/.test(listText) ? 'wholesale' : /^(r|retail|regular|normal)$/.test(listText) ? 'retail' : undefined;
    if (priceList === undefined) { fail(`Price list "${get(r, 'priceList')}" is not retail or wholesale`); continue; }
    const match = (tin && byTin.get(tin)) || (email && byEmail.get(email.toLowerCase())) || null;
    const partial = (street || city || district) && !fullAddress ? 'address left out: it needs a street, a town and a district' : undefined;
    results.push({ row: n, action: match ? 'update' : 'create', name, ...(partial || tin ? { detail: [tin && `TIN ${tin}`, partial].filter(Boolean).join('; ') } : {}) });
    if (options.dryRun) continue;
    const phone = get(r, 'phone') || null;
    if (match) {
      await db.query(
        `update customers set name = $3, tin = coalesce($4, tin), email = coalesce($5, email), telephone = coalesce($6, telephone),
           street = case when $10 then $7 else street end, city = case when $10 then $8 else city end, district_code = case when $10 then $9 else district_code end,
           price_list = coalesce($11, price_list)
         where id = $1 and tenant_id = $2`,
        [match, tenantId, name, tin, email, phone, street, city, district, fullAddress, priceList],
      );
    } else {
      const id = randomUUID();
      await db.query(
        `insert into customers (id, tenant_id, name, tin, street, city, district_code, telephone, email, price_list) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, tenantId, name, tin, fullAddress ? street : null, fullAddress ? city : null, fullAddress ? district : null, phone, email, priceList ?? 'retail'],
      );
      if (tin) byTin.set(tin, id);
      if (email) byEmail.set(email.toLowerCase(), id);
    }
  }
  return summarize(rows.length - 1, results);
}

function summarize(rows: number, results: RowResult[]): ImportResult {
  return {
    rows,
    created: results.filter((r) => r.action === 'create').length,
    updated: results.filter((r) => r.action === 'update').length,
    errors: results.filter((r) => r.action === 'error').length,
    results,
  };
}
