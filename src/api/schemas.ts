/** JSON schemas shared by the routes. Fastify validates every request against them. */

export const decimal = { type: 'string', pattern: '^-?\\d{1,15}(\\.\\d{1,6})?$' } as const;
export const money = { type: 'string', pattern: '^-?\\d{1,15}(\\.\\d{1,2})?$' } as const;
export const uuid = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' } as const;
export const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
export const time = { type: 'string', pattern: '^\\d{2}:\\d{2}:\\d{2}$' } as const;
export const tin = { type: 'string', pattern: '^\\d{6}$' } as const;
export const etdui = { type: 'string', pattern: '^\\d{44}$' } as const;
const text = (max = 500) => ({ type: 'string', minLength: 1, maxLength: max }) as const;

export const addressSchema = {
  type: 'object',
  required: ['street', 'city', 'districtCode'],
  additionalProperties: false,
  properties: {
    street: text(200),
    additionalStreet: text(200),
    city: text(100),
    districtCode: { type: 'string', enum: ['1', '2', '3', '4', '5', '6'] },
  },
} as const;

export const contactSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { telephone: text(50), email: text(254) },
} as const;

export const customerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: text(300),
    tin,
    otherId: { type: 'object', required: ['scheme', 'value'], additionalProperties: false, properties: { scheme: text(50), value: text(100) } },
    address: addressSchema,
    contact: contactSchema,
    priceList: { type: 'string', enum: ['retail', 'wholesale'] },
    creditLimit: { anyOf: [{ type: 'string', pattern: '^\\d{1,10}(\\.\\d{1,2})?$' }, { type: 'null' }] },
    withholdsContractTax: { type: 'boolean' },
  },
} as const;

export const tenantSchema = {
  type: 'object',
  required: ['legalName', 'tin', 'address', 'contact', 'environment'],
  additionalProperties: false,
  properties: {
    legalName: text(300),
    tradeName: text(300),
    tin,
    address: addressSchema,
    contact: { ...contactSchema, required: ['telephone', 'email'] },
    environment: { type: 'string', enum: ['test', 'production'] },
    slug: { type: 'string', minLength: 3, maxLength: 40 },
  },
} as const;

export const certificateSchema = {
  type: 'object',
  required: ['certificatePem', 'privateKeyPem'],
  additionalProperties: false,
  properties: {
    certificatePem: { type: 'string', minLength: 100, maxLength: 20_000 },
    privateKeyPem: { type: 'string', minLength: 100, maxLength: 20_000 },
    passphrase: { type: 'string', maxLength: 500 },
  },
} as const;

export const itemSchema = {
  type: 'object',
  required: ['name', 'unitCode', 'unitPrice', 'gstCategory'],
  additionalProperties: false,
  properties: {
    name: text(300),
    description: text(1000),
    sellerCode: text(100),
    unitCode: { type: 'string', pattern: '^[A-Z0-9]{1,3}$' },
    unitPrice: decimal,
    gstCategory: { type: 'string', enum: ['S', 'Z', 'E'] },
    exemptionReasonCode: text(50),
    barcode: { type: 'string', pattern: '^[0-9A-Za-z-]{1,64}$' },
    favorite: { type: 'boolean' },
    category: { anyOf: [{ type: 'string', minLength: 1, maxLength: 80 }, { type: 'null' }] },
    // The price (before GST) for customers on the wholesale list; null: they pay the usual price.
    wholesalePrice: { anyOf: [{ type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,6})?$' }, { type: 'null' }] },
    // Lower prices for larger quantities; left out on an edit, they stay as they were.
    priceBreaks: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object', required: ['minQuantity', 'unitPrice'], additionalProperties: false,
        properties: { minQuantity: { type: 'string', pattern: '^\\d{1,9}(\\.\\d{1,3})?$' }, unitPrice: { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,6})?$' } },
      },
    },
  },
} as const;

const allowanceCharge = {
  type: 'object',
  required: ['isCharge', 'reason'],
  additionalProperties: false,
  properties: { isCharge: { type: 'boolean' }, reason: text(200), amount: money, percent: decimal, perUnit: decimal },
} as const;

const otherTax = {
  type: 'object',
  required: ['scheme'],
  additionalProperties: false,
  properties: { scheme: { type: 'string', enum: ['ENV', 'EXC'] }, perUnit: decimal, percent: decimal, inGstBase: { type: 'boolean' } },
} as const;

export const issueSchema = {
  type: 'object',
  required: ['type', 'lines'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['01', '02', '03', '04'] },
    series: { type: 'integer', minimum: 1, maximum: 999 },
    customerId: uuid,
    customer: customerSchema,
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['quantity'],
        additionalProperties: false,
        properties: {
          itemId: uuid,
          description: text(1000),
          itemName: text(300),
          sellerItemCode: text(100),
          quantity: decimal,
          unitCode: { type: 'string', pattern: '^[A-Z0-9]{1,3}$' },
          unitPrice: decimal,
          gstCategory: { type: 'string', enum: ['S', 'Z', 'E'] },
          exemptionReasonCode: text(50),
          exemptionReason: text(300),
          allowanceCharges: { type: 'array', maxItems: 20, items: allowanceCharge },
          otherTaxes: { type: 'array', maxItems: 5, items: otherTax },
        },
      },
    },
    reference: {
      type: 'object',
      required: ['reason'],
      additionalProperties: false,
      properties: { documentId: uuid, etdui, issueDate: date, issueTime: time, reason: text(500) },
    },
    payment: {
      type: 'object',
      additionalProperties: false,
      properties: { meansCode: { type: 'string', pattern: '^\\d{1,3}$' }, dueDate: date, terms: text(500) },
    },
    note: text(1000),
    // The customer withholds contract tax (a tax invoice only).
    contractTax: { type: 'boolean' },
    prepaidAmount: money,
    payableRoundingAmount: money,
    // Tax receipts paid partly one way and partly another (cash and card): the parts, adding up to the total.
    overrideCreditLimit: { type: 'boolean' },
    redeemPoints: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    giftCard: {
      type: 'object', required: ['code', 'amount'], additionalProperties: false,
      properties: { code: { type: 'string', minLength: 16, maxLength: 40 }, amount: money },
    },
    // A layaway (tax invoices on a saved customer's account): until when the goods are kept, and the deposit paid now.
    layaway: {
      type: 'object', required: ['holdUntil'], additionalProperties: false,
      properties: {
        holdUntil: date,
        deposit: { type: 'object', required: ['amount', 'method'], additionalProperties: false, properties: { amount: money, method: { type: 'string', enum: ['cash', 'cheque', 'bank_transfer', 'card', 'online', 'other'] }, reference: text(100) } },
        note: text(300),
      },
    },
    // A tip added to a card or wallet payment of a receipt: kept for the staff, not on the document.
    tip: { type: 'object', required: ['amount', 'meansCode'], additionalProperties: false, properties: { amount: money, meansCode: { type: 'string', pattern: '^\\d{1,3}$' } } },
    tenders: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: { type: 'object', required: ['meansCode', 'amount'], additionalProperties: false, properties: { meansCode: { type: 'string', pattern: '^\\d{1,3}$' }, amount: money } },
    },
    // Tax invoices and debit notes: already paid in full when issued (recorded as a payment).
    paid: {
      type: 'object',
      required: ['method'],
      additionalProperties: false,
      properties: { method: { type: 'string', enum: ['cash', 'cheque', 'bank_transfer', 'card', 'online', 'other'] }, reference: text(100) },
    },
  },
} as const;

export const listQuery = (extra: Record<string, unknown> = {}) =>
  ({
    type: 'object',
    additionalProperties: false,
    properties: { limit: { type: 'string', pattern: '^\\d{1,3}$' }, cursor: { type: 'string', maxLength: 200 }, ...extra },
  }) as const;
