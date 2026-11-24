/**
 * What each webhook event carries, as an example: the `data` of a delivery.
 * The reference shows these, and "Send a test" delivers them (marked
 * `"test": true`), so an endpoint can be written and tried before anything
 * real happens. test/webhooks.test.ts checks them against real events.
 */

import type { WEBHOOK_EVENTS } from './webhooks.ts';

const ORDER = {
  id: '7c1f6c2e-52c7-4a3b-9c0d-1c2b3a4d5e6f', number: 1001, status: 'open', paymentStatus: 'paid', fulfillmentStatus: 'unfulfilled',
  paymentMethod: 'online', fulfillment: 'pickup',
  customer: { name: 'Ana Buyer', email: 'ana@example.com', phone: '+501 610-0000' },
  totals: { total: '45.00', refunded: '0.00' },
  documentId: '0b2f8f0a-6a55-4a0e-8f0e-2d1c4b6a7e90', createdAt: '2026-11-24T16:06:16.128Z', paidAt: '2026-11-24T16:07:02.511Z',
};

const DOCUMENT = {
  id: '0b2f8f0a-6a55-4a0e-8f0e-2d1c4b6a7e90', etdui: '02000001234560010000000010000000011234567890', type: '02', number: '001-000000001',
  issueDate: '2026-11-24', status: 'authorized', environment: 'test',
  customer: { name: 'Ana Buyer', tin: null }, referencedEtdui: null,
  totals: { lineExtension: '40.00', gst: '5.00', taxInclusive: '45.00' },
  protocolNumber: '05000000100123456789001260128200910244111466', conditions: [],
};

const INVOICE = {
  documentId: '0b2f8f0a-6a55-4a0e-8f0e-2d1c4b6a7e90', type: '01', number: '001-000000007', issueDate: '2026-11-01', dueDate: '2026-12-01', daysOverdue: 0,
  customer: { id: '7d1f0c2a-1b2c-4d3e-8f90-a1b2c3d4e5f6', key: 'c:7d1f0c2a-1b2c-4d3e-8f90-a1b2c3d4e5f6', name: 'Island Logistics Ltd.', tin: '777888', email: 'accounts@islandlogistics.example' },
  total: '112.50', paid: '112.50', credited: '0.00', withheld: '0.00', balance: '0.00', status: 'paid',
};

const PRODUCT = {
  id: '23fc131f-f8ff-4d0f-b5a8-239e17312a2c', title: 'Island T-shirt', handle: 'island-t-shirt', description: 'Soft cotton, printed in San Pedro.',
  status: 'active', option1Name: 'Size', option2Name: null, badge: null, tags: ['clothing'],
  variants: [{
    id: '5ccd1c08-9412-4ca7-9958-f2a0c011e996', title: 'S', option1: 'S', option2: null, price: '40.00', priceWithGst: '45.00', compareAtPrice: null,
    gstCategory: 'S', exemptionReasonCode: null, unitCode: 'H87', sellerCode: 'TEE-S', barcode: null, stock: 5,
  }],
  images: [{ id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', contentType: 'image/jpeg', bytes: 182044 }],
  createdAt: '2026-11-20T14:00:00.000Z', updatedAt: '2026-11-24T16:00:00.000Z',
};

/** The `data` of each event type. */
export const SAMPLE_EVENT_DATA: Record<(typeof WEBHOOK_EVENTS)[number], Record<string, unknown>> = {
  'document.authorized': { document: DOCUMENT },
  'document.rejected': { document: { ...DOCUMENT, status: 'rejected', protocolNumber: null, conditions: [{ code: '204', description: 'The TIN of the customer is not registered' }] } },
  'document.cancelled': { document: { ...DOCUMENT, status: 'cancelled' } },
  'document.issued_offline': { document: { ...DOCUMENT, status: 'contingency_pending', protocolNumber: null } },
  'order.placed': { order: { ...ORDER, paymentStatus: 'unpaid', documentId: null, paidAt: null } },
  'order.paid': { order: ORDER },
  'order.payment_failed': {
    order: { ...ORDER, paymentStatus: 'unpaid', documentId: null, paidAt: null },
    payment: { id: '75975f1f-e261-4371-bdda-3a1c392a2fd8', provider: 'belizebank', status: 'failed', reason: 'The card was declined', amount: '45.00', createdAt: '2026-11-24T16:06:40.000Z' },
  },
  'order.fulfilled': { order: { ...ORDER, fulfillmentStatus: 'fulfilled' } },
  'order.cancelled': { order: { ...ORDER, status: 'cancelled', paymentStatus: 'unpaid', documentId: null, paidAt: null } },
  'order.refunded': {
    refund: { id: '4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b', amount: '45.00', reason: 'Wrong size', lines: [{ lineNumber: 1, quantity: 1 }], delivery: false, documentId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', createdAt: '2026-11-25T10:00:00.000Z' },
    order: { ...ORDER, totals: { total: '45.00', refunded: '45.00' } },
  },
  'payment.recorded': {
    payment: { id: '2b3c4d5e-6f70-4a81-9b92-c3d4e5f60718', documentId: INVOICE.documentId, amount: '112.50', method: 'bank_transfer', reference: 'TRF 88213', paidOn: '2026-11-24', note: null, recordedBy: 'Rosa Castillo', createdAt: '2026-11-24T15:00:00.000Z', voided: false, voidReason: null },
    invoice: INVOICE,
  },
  'invoice.paid': { invoice: INVOICE },
  'expense.recorded': {
    expense: {
      id: '3c4d5e6f-7081-4b92-8ca3-d4e5f6071829', supplier: { id: null, name: 'Belize Electricity Ltd', tin: null }, reference: 'INV-5521', date: '2026-11-24', dueDate: null,
      category: 'Utilities', description: 'November electricity', gstTreatment: 'standard', totals: { net: '200.00', gst: '25.00', total: '225.00' }, claimGst: true,
      paid: { on: '2026-11-24', method: 'bank_transfer' }, recurringExpenseId: null, createdAt: '2026-11-24T15:30:00.000Z',
    },
  },
  'stock.received': {
    receipt: {
      id: '5e6f7081-92a3-4cb4-9dc5-e6f708192a3b', supplier: { id: null, name: 'Caribbean Textiles' }, reference: 'DN-1040', receivedOn: '2026-11-24', totalCost: '360.00',
      expenseId: null, purchaseOrderId: null, createdAt: '2026-11-24T13:00:00.000Z',
      lines: [{ itemId: PRODUCT.variants[0]!.id, name: 'Island T-shirt – S', code: 'TEE-S', quantity: '20', unitCost: '18' }],
    },
  },
  'stock.changed': {
    item: { id: PRODUCT.variants[0]!.id, name: 'Island T-shirt – S', code: 'TEE-S', quantity: '4', available: true, lowStock: false, product: { id: PRODUCT.id, handle: PRODUCT.handle } },
  },
  'purchase_order.received': {
    purchaseOrder: {
      id: '6f708192-a3b4-4dc5-8ed6-f708192a3b4c', number: 'PO-12', supplier: { id: null, name: 'Caribbean Textiles' }, status: 'received', expectedOn: '2026-11-24', total: '360.00',
      createdAt: '2026-11-18T09:00:00.000Z',
      lines: [{ itemId: PRODUCT.variants[0]!.id, description: 'Island T-shirt – S', quantity: '20', received: '20', unitCost: '18' }],
    },
  },
  'product.created': { product: PRODUCT },
  'product.updated': { product: PRODUCT },
  'product.deleted': { product: { ...PRODUCT, status: 'archived' } },
};
