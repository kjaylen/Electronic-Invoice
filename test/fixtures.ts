/** Shared test data: a sample supplier and helpers that build complete, consistent documents. */
import { calculateDocument, type DocumentInput } from '../src/engine/calc.ts';
import { buildEtdui, type OperMode } from '../src/engine/etdui.ts';
import { buildSequenceInfo } from '../src/engine/sequence.ts';
import type { IssuedEtdType, Supplier, UblDocumentInput } from '../src/engine/ubl.ts';

export const SUPPLIER: Supplier = {
  legalName: 'Caribbean Fuel & Supply Ltd.',
  tradeName: 'CaribFuel',
  tin: '123456',
  address: { street: '12 Regent Street', city: 'Belize City', districtName: 'Belize', districtCode: '1' },
  contact: { telephone: '+501 222 3333', email: 'billing@caribfuel.example' },
};

export const LINES: DocumentInput = {
  lines: [
    {
      description: 'Diesel',
      quantity: '3000',
      unitCode: 'GLL',
      unitPrice: '5.7354',
      gstCategory: 'S',
      allowanceCharges: [{ isCharge: true, reason: 'Freight', perUnit: '0.11' }],
      otherTaxes: [
        { scheme: 'ENV', perUnit: '0.17' },
        { scheme: 'EXC', perUnit: '2.9727' },
      ],
    },
    {
      description: 'Engine oil 5W-30',
      quantity: '4',
      unitCode: 'H87',
      unitPrice: '45.00',
      gstCategory: 'S',
      allowanceCharges: [{ isCharge: false, reason: 'Loyalty discount', percent: '10' }],
    },
    { description: 'Rice 25 lb', quantity: '2', unitCode: 'H87', unitPrice: '32.50', gstCategory: 'Z' },
  ],
};

const SECURITY_CODE = '473298514';

export function etduiFor(etdType: IssuedEtdType, serial: number, operMode: OperMode = 1, series = 1): string {
  return buildEtdui({
    etdType,
    tin: SUPPLIER.tin,
    serial,
    series,
    issueDate: '2026-11-21',
    issueTime: '14:05',
    operMode,
    receptionEnv: '02',
    securityCode: SECURITY_CODE,
  });
}

/** A complete, valid document of the given type. Override any field. */
export function makeDocument(etdType: IssuedEtdType, overrides: Partial<UblDocumentInput> = {}): UblDocumentInput {
  const etdui = overrides.etdui ?? etduiFor(etdType, 42);
  const totals = overrides.totals ?? calculateDocument(LINES);
  const sequence =
    overrides.sequence ??
    buildSequenceInfo(
      { uuid: etdui, lineCount: totals.lineCount, taxAmount: totals.taxAmount, lineExtensionAmount: totals.lineExtensionAmount },
      null,
    );
  const isNote = etdType === '03' || etdType === '04';
  return {
    etdType,
    etdui,
    issueDate: '2026-11-21',
    issueTime: '14:05:33',
    supplier: SUPPLIER,
    customer:
      etdType === '02'
        ? undefined
        : {
            name: 'Island Logistics Ltd.',
            tin: '654321',
            address: { street: '4 Mile Northern Highway', city: 'Belize City', districtName: 'Belize', districtCode: '1' },
            contact: { telephone: '+501 223 4455', email: 'ap@islandlogistics.example' },
          },
    totals,
    sequence,
    ...(isNote && { reference: { etdui: etduiFor('01', 41), issueDate: '2026-11-20', reason: 'Price correction' } }),
    payment: { meansCode: '30', dueDate: '2026-12-21', terms: 'Net 30' },
    ...overrides,
  };
}
