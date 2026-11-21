import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicationResponse, parseDocumentQuery, parseSystemStatus, ResponseParseError } from '../src/engine/response.ts';
import { applicationResponse } from './fake-bts.ts';

// The body of BTS's example reply in manual 7.3.1 (signature extension omitted).
const MANUAL_REPLY =
  '<ApplicationResponse xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ' +
  'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ' +
  'xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2">' +
  '<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>urn:ciat:efdr:customization:1.0</cbc:CustomizationID>' +
  '<cbc:ID>000133268</cbc:ID><cbc:UUID>05000000100013326800126012820091024411146627</cbc:UUID>' +
  '<cbc:IssueDate>2026-01-28</cbc:IssueDate><cbc:IssueTime>20:09:44-06:00</cbc:IssueTime>' +
  '<cac:SenderParty><cac:PartyName><cbc:Name>Belize Tax Service</cbc:Name></cac:PartyName></cac:SenderParty>' +
  '<cac:DocumentResponse><cac:Response><cbc:ReferenceID>Whole document</cbc:ReferenceID>' +
  '<cbc:ResponseCode>001</cbc:ResponseCode><cbc:Description>ETD Authorizing Protocol</cbc:Description></cac:Response>' +
  '<cac:DocumentReference><cbc:UUID>01023456777401919700126012823091021306598061</cbc:UUID>' +
  '<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode><cbc:DocumentType>Tax Invoice</cbc:DocumentType></cac:DocumentReference>' +
  '</cac:DocumentResponse></ApplicationResponse>';

test("parses the manual's example authorization reply", () => {
  assert.deepEqual(parseApplicationResponse(MANUAL_REPLY), {
    conditions: [],
    responseUuid: '05000000100013326800126012820091024411146627',
    responseId: '000133268',
    issueDate: '2026-01-28',
    issueTime: '20:09:44-06:00',
    responseCode: '001',
    description: 'ETD Authorizing Protocol',
    referencedEtdui: '01023456777401919700126012823091021306598061',
    referencedTypeCode: '01',
  });
});

test('parses rejection conditions', () => {
  const xml = applicationResponse({
    responseCode: '003',
    referencedEtdui: '01023456777401919700126012823091021306598061',
    conditions: [
      { code: '283', description: 'Rejection: Accounting Customer Party is mandatory for the Invoice schema' },
      { code: '278', description: 'Warning: Invoice Type Code list ID must contain "UN/ECE 1001 Subset"' },
    ],
  });
  const info = parseApplicationResponse(xml);
  assert.equal(info.responseCode, '003');
  assert.deepEqual(info.conditions.map((c) => c.code), ['283', '278']);
  assert.match(info.conditions[0]!.description!, /Accounting Customer Party/);
});

test('rejects anything that is not an ApplicationResponse', () => {
  assert.throws(() => parseApplicationResponse('<Invoice/>'), ResponseParseError);
  assert.throws(() => parseApplicationResponse('not xml'), ResponseParseError);
});

test('Document Query: JSON in several plausible shapes', () => {
  const etdui = '01023456777401919700126012823091021306598061';
  assert.equal(parseDocumentQuery(JSON.stringify({ GetDocument: { UUID: etdui, ResponseCode: '004' } })).status, 'not_found');
  assert.equal(parseDocumentQuery(JSON.stringify({ uuid: etdui, responseCode: '005' })).status, 'authorized');
  assert.equal(parseDocumentQuery(JSON.stringify({ 'cbc:ResponseCode': '006' })).status, 'authorized_with_alert');
  assert.equal(parseDocumentQuery(JSON.stringify({ getDocument: { responseCode: '007' } })).status, 'cancelled');
  const full = parseDocumentQuery(
    JSON.stringify({ GetDocument: { UUID: etdui, ResponseCode: '005', ResultETD: { ETD: { ReferencedXML: '<Invoice/>' }, ApplicationResponse: [{ ETDEvent: '<A/>' }, { ETDEvent: '<B/>' }] } } }),
  );
  assert.equal(full.etdui, etdui);
  assert.equal(full.etdXml, '<Invoice/>');
  assert.deepEqual(full.events, ['<A/>', '<B/>']);
});

test('Document Query: an XML body works too', () => {
  const xml = '<GetDocument xmlns:cbc="x"><cbc:UUID>1</cbc:UUID><cbc:ResponseCode>005</cbc:ResponseCode></GetDocument>';
  assert.equal(parseDocumentQuery(xml).status, 'authorized');
});

test('System Status: operating, down, and average response time', () => {
  const up = parseSystemStatus(JSON.stringify({ GetStatus: { ResponseCode: '008', Description: 'EFDR: system operating normally', StatusResponseTime: 412 } }));
  assert.equal(up.operational, true);
  assert.equal(up.averageResponseMs, 412);
  assert.equal(parseSystemStatus(JSON.stringify({ GetStatus: { ResponseCode: '009' } })).operational, false);
  assert.throws(() => parseSystemStatus('garbage'), ResponseParseError);
});
