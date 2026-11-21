/**
 * A fake BTS reception server for tests: HTTPS with mandatory client
 * certificates (mutual TLS), signed by the test root CA. Each route plays a
 * scripted list of replies in order, the last one repeating.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';

const certs = new URL('./certs/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, certs), 'utf8');
export const TEST_ROOT_CA = read('test-root-ca.cert.pem');

export interface ScriptedReply {
  status: number;
  body?: string;
  contentType?: string;
  /** Delay before answering, to simulate a slow or hung server. */
  delayMs?: number;
  /** Drop the connection without answering. */
  hangUp?: boolean;
}

export interface ReceivedRequest {
  method: string;
  path: string;
  contentType: string;
  body: string;
  /** Subject CN of the client certificate presented. */
  clientCn: string | undefined;
}

export interface FakeBts {
  baseUrl: string;
  requests: ReceivedRequest[];
  script(path: string, ...replies: ScriptedReply[]): void;
  close(): Promise<void>;
}

export async function startFakeBts(options: { trustedCa?: string } = {}): Promise<FakeBts> {
  const scripts = new Map<string, ScriptedReply[]>();
  const requests: ReceivedRequest[] = [];
  const server: Server = createServer(
    {
      key: read('server-localhost.key.pem'),
      cert: read('server-localhost.cert.pem'),
      ca: options.trustedCa ?? TEST_ROOT_CA,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0]!;
        const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
        requests.push({
          method: req.method ?? '',
          path,
          contentType: String(req.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
          clientCn: peer?.subject?.CN as string | undefined,
        });
        const queue = scripts.get(path) ?? [{ status: 404, body: 'no script' }];
        const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
        const send = () => {
          if (reply.hangUp) {
            req.socket.destroy();
            return;
          }
          res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'application/xml' });
          res.end(reply.body ?? '');
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `https://localhost:${port}`,
    requests,
    script(path, ...replies) {
      scripts.set(path, replies);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A BTS-style ApplicationResponse, shaped like the example in manual 7.3.1 (unsigned). */
export function applicationResponse(options: {
  responseCode: '001' | '002' | '003';
  referencedEtdui: string;
  protocol?: string;
  conditions?: Array<{ code: string; description: string }>;
}): string {
  const descriptions = { '001': 'ETD Authorizing Protocol', '002': 'ETD Authorizing Protocol with Alert', '003': 'ETD Rejection' };
  const status = (options.conditions ?? [])
    .map((c) => `<cac:Status><cbc:ConditionCode>${c.code}</cbc:ConditionCode><cbc:Description>${c.description}</cbc:Description></cac:Status>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" ' +
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ' +
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">' +
    '<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>urn:ciat:efdr:customization:1.0</cbc:CustomizationID>' +
    `<cbc:ID>000133268</cbc:ID><cbc:UUID>${options.protocol ?? '05000000100013326800126012820091024411146627'}</cbc:UUID>` +
    '<cbc:IssueDate>2026-01-28</cbc:IssueDate><cbc:IssueTime>20:09:44-06:00</cbc:IssueTime>' +
    '<cac:SenderParty><cac:PartyName><cbc:Name>Belize Tax Service</cbc:Name></cac:PartyName></cac:SenderParty>' +
    '<cac:DocumentResponse><cac:Response><cbc:ReferenceID>Whole document</cbc:ReferenceID>' +
    `<cbc:ResponseCode>${options.responseCode}</cbc:ResponseCode><cbc:Description>${descriptions[options.responseCode]}</cbc:Description>${status}` +
    '</cac:Response><cac:DocumentReference>' +
    `<cbc:UUID>${options.referencedEtdui}</cbc:UUID><cbc:DocumentTypeCode>${options.referencedEtdui.slice(0, 2)}</cbc:DocumentTypeCode>` +
    '<cbc:DocumentType>Tax Invoice</cbc:DocumentType></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>'
  );
}

export function documentQueryReply(etdui: string, code: '004' | '005' | '006' | '007', etdXml?: string): string {
  const descriptions = { '004': 'ETD not located', '005': 'ETD located', '006': 'ETD located with alerts', '007': 'ETD cancelled' };
  return JSON.stringify({
    GetDocument: {
      UUID: etdui,
      ResponseCode: code,
      Description: descriptions[code],
      ReferenceDate: '2026-11-21',
      ReferenceTime: '14:06:00-06:00',
      ...(etdXml && { ResultETD: { ETD: { ReferencedXML: etdXml }, ApplicationResponse: [{ ETDEvent: '<ApplicationResponse/>' }] } }),
    },
  });
}
