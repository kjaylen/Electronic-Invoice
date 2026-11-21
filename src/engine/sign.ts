/**
 * XAdES-EPES enveloped signature for Electronic Tax Documents (manual 8.3).
 *
 *   Standard        XMLDSig enveloped, XAdES-EPES (XAdES v1.3.2)
 *   Signature       RSA-SHA256   http://www.w3.org/2001/04/xmldsig-more#rsa-sha256
 *   Digest          SHA-256      http://www.w3.org/2001/04/xmlenc#sha256
 *   Canonicalization C14N 1.0    http://www.w3.org/TR/2001/REC-xml-c14n-20010315
 *   References      URI=""  (enveloped-signature, then C14N) over the whole document,
 *                   and #...-signedprops of Type ...#SignedProperties
 *   Location        UBLExtensions/UBLExtension/ExtensionContent/Signature, in its own
 *                   UBLExtension after the EFDR one (BTS rules C06 and C07)
 *
 * The layout and Id naming follow the signature BTS itself produced in the
 * manual (section 7.3.1, January 2026): Signature Id "xmldsig-<uuid>-sigvalue",
 * document Reference Id "xmldsig-<uuid>", KeyInfo "-keyinfo", SignedProperties
 * "-signedprops", and KeyInfo with X509IssuerSerial, X509SubjectName and
 * X509Certificate.
 *
 * Inclusive C14N of SignedProperties and SignedInfo includes the namespace
 * declarations inherited from the document, so both are digested in their
 * final position inside the document, not as standalone fragments.
 */

import { createHash, randomUUID, sign as rsaSign } from 'node:crypto';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { C14nCanonicalization, findAncestorNs } from 'xml-crypto';
import { assertCertificateUsable, type SigningCredentials } from './certificate.ts';
import { MAX_DOCUMENT_BYTES } from './ubl.ts';
import { el, leaf, serialize, type XmlElement } from './xml.ts';

export const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
export const XADES_NS = 'http://uri.etsi.org/01903/v1.3.2#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const SIGNED_PROPERTIES_TYPE = 'http://uri.etsi.org/01903#SignedProperties';
const UBL_EXT_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const CAC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const CBC_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';

export interface SignaturePolicy {
  /** SigPolicyId/Identifier. */
  identifier: string;
  /** SHA-256 of the policy document, Base64. */
  digestValue: string;
}

/**
 * The policy in BTS's own production signature (manual 7.3.1). The PDF now
 * published at that URL hashes to ASZbXZ+3tPmWjkvBqnJ6kdahIFe4PI5rSQsG3HQyEn0=,
 * so the file may have been revised; which hash BTS expects is an open question.
 */
export const BTS_SIGNATURE_POLICY: SignaturePolicy = Object.freeze({
  identifier: 'https://efdrshare.blob.core.windows.net/documentation/bz/sigPolicyv1.pdf',
  digestValue: 'k2uAJ+0STF8ByHKCAvdesW6J6+OBhVxuc6xJLBIA8es=',
});

export interface SignOptions {
  /** Defaults to now. Also the moment the certificate must be valid. */
  signingTime?: Date;
  policy?: SignaturePolicy;
  /** Base for the element Ids. Defaults to "xmldsig-<random uuid>"; set it only in tests. */
  idBase?: string;
}

export interface SignedDocument {
  xml: string;
  byteLength: number;
  signatureId: string;
  signingTime: string;
}

export class SignError extends Error {
  override name = 'SignError';
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('base64');

function parse(xml: string): Document {
  const errors: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg); } }).parseFromString(xml, 'text/xml');
  } catch (e) {
    throw new SignError(`Document is not well-formed XML: ${(e as Error).message}`);
  }
  if (errors.length > 0 || !doc.documentElement) throw new SignError(`Document is not well-formed XML: ${errors[0] ?? 'no root'}`);
  return doc;
}

function elementsNS(node: Document | Element, ns: string, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS(ns, name));
}

function childElements(parent: Element, ns: string, name: string): Element[] {
  return Array.from(parent.childNodes).filter(
    (n): n is Element => (n as Element).namespaceURI === ns && (n as Element).localName === name,
  );
}

/** The issuer TIN the certificate must match (BTS code 243). */
function supplierTin(doc: Document): string {
  const root = doc.documentElement!;
  const partyTag = root.localName === 'ApplicationResponse' ? 'SenderParty' : 'AccountingSupplierParty';
  const party = childElements(root, CAC_NS, partyTag)[0];
  const scheme = party && elementsNS(party, CAC_NS, 'PartyTaxScheme')[0];
  const tin = scheme && childElements(scheme, CBC_NS, 'CompanyID')[0]?.textContent?.trim();
  if (!tin) throw new SignError(`Document has no ${partyTag} PartyTaxScheme/CompanyID`);
  return tin;
}

function canonicalize(doc: Document, node: Element, xpath?: string): string {
  const ancestorNamespaces = xpath ? findAncestorNs(doc as never, xpath) : [];
  return new C14nCanonicalization().process(node as never, { ancestorNamespaces });
}

function findById(doc: Document, id: string): Element {
  const matches = Array.from(doc.getElementsByTagName('*')).filter((e) => (e as Element).getAttribute('Id') === id);
  if (matches.length !== 1) throw new SignError(`Expected one element with Id ${id}, found ${matches.length}`);
  return matches[0] as Element;
}

function signedProperties(id: string, signingTime: string, creds: SigningCredentials, policy: SignaturePolicy): XmlElement {
  const c = creds.certificate;
  return el(
    'xades:SignedProperties',
    { Id: `${id}-signedprops` },
    el(
      'xades:SignedSignatureProperties',
      undefined,
      leaf('xades:SigningTime', signingTime),
      el(
        'xades:SigningCertificate',
        undefined,
        el(
          'xades:Cert',
          undefined,
          el('xades:CertDigest', undefined, el('ds:DigestMethod', { Algorithm: SHA256 }), leaf('ds:DigestValue', c.sha256Base64)),
          el('xades:IssuerSerial', undefined, leaf('ds:X509IssuerName', c.issuerName), leaf('ds:X509SerialNumber', c.serialNumber)),
        ),
      ),
      el(
        'xades:SignaturePolicyIdentifier',
        undefined,
        el(
          'xades:SignaturePolicyId',
          undefined,
          el('xades:SigPolicyId', undefined, leaf('xades:Identifier', policy.identifier)),
          el('xades:SigPolicyHash', undefined, el('ds:DigestMethod', { Algorithm: SHA256 }), leaf('ds:DigestValue', policy.digestValue)),
        ),
      ),
    ),
  );
}

function signatureElement(
  id: string,
  documentDigest: string,
  propsDigest: string,
  signatureValue: string,
  props: XmlElement,
  creds: SigningCredentials,
): XmlElement {
  const c = creds.certificate;
  return el(
    'ds:Signature',
    { 'xmlns:ds': DSIG_NS, Id: `${id}-sigvalue` },
    el(
      'ds:SignedInfo',
      undefined,
      el('ds:CanonicalizationMethod', { Algorithm: C14N }),
      el('ds:SignatureMethod', { Algorithm: RSA_SHA256 }),
      el(
        'ds:Reference',
        { Id: id, URI: '' },
        el('ds:Transforms', undefined, el('ds:Transform', { Algorithm: ENVELOPED }), el('ds:Transform', { Algorithm: C14N })),
        el('ds:DigestMethod', { Algorithm: SHA256 }),
        leaf('ds:DigestValue', documentDigest),
      ),
      el(
        'ds:Reference',
        { URI: `#${id}-signedprops`, Type: SIGNED_PROPERTIES_TYPE },
        el('ds:DigestMethod', { Algorithm: SHA256 }),
        leaf('ds:DigestValue', propsDigest),
      ),
    ),
    leaf('ds:SignatureValue', signatureValue),
    el(
      'ds:KeyInfo',
      { Id: `${id}-keyinfo` },
      el(
        'ds:X509Data',
        undefined,
        el('ds:X509IssuerSerial', undefined, leaf('ds:X509IssuerName', c.issuerName), leaf('ds:X509SerialNumber', c.serialNumber)),
        leaf('ds:X509SubjectName', c.subjectName),
        leaf('ds:X509Certificate', c.derBase64),
      ),
    ),
    el('ds:Object', undefined, el('xades:QualifyingProperties', { 'xmlns:xades': XADES_NS, Target: `#${id}-sigvalue` }, props)),
  );
}

/**
 * Sign an unsigned ETD (from the ubl module) with the taxpayer's credentials.
 * Checks first that the certificate is valid at the signing time and belongs
 * to the document's issuer.
 */
export function signDocument(unsignedXml: string, creds: SigningCredentials, options: SignOptions = {}): SignedDocument {
  const signingDate = options.signingTime ?? new Date();
  const signingTime = signingDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const policy = options.policy ?? BTS_SIGNATURE_POLICY;
  const id = options.idBase ?? `xmldsig-${randomUUID()}`;
  if (!/^[A-Za-z_][\w.-]*$/.test(id)) throw new SignError('idBase must be a valid XML Id');

  const unsigned = parse(unsignedXml);
  if (elementsNS(unsigned, DSIG_NS, 'Signature').length > 0) {
    throw new SignError('Document is already signed (BTS code 226)');
  }
  if (elementsNS(unsigned, UBL_EXT_NS, 'UBLExtensions').length !== 1) {
    throw new SignError('Document must have exactly one UBLExtensions element');
  }
  assertCertificateUsable(creds.certificate, { tin: supplierTin(unsigned), at: signingDate });

  // Insert a second UBLExtension, reusing the document's prefix for the extension namespace.
  const close = /<\/((?:[\w.-]+:)?)UBLExtensions>/.exec(unsignedXml);
  if (!close) throw new SignError('Could not find the end of UBLExtensions');
  const p = close[1]!;
  const withSignature = (signature: string) =>
    unsignedXml.slice(0, close.index) +
    `<${p}UBLExtension><${p}ExtensionContent>${signature}</${p}ExtensionContent></${p}UBLExtension>` +
    unsignedXml.slice(close.index);

  // 1. Document digest. The enveloped-signature transform removes the Signature element and
  //    leaves its empty ExtensionContent, which is exactly this document.
  const placeholderDoc = parse(withSignature(''));
  const documentDigest = sha256(canonicalize(placeholderDoc, placeholderDoc.documentElement!));

  // 2. SignedProperties digest, computed in place.
  const props = signedProperties(id, signingTime, creds, policy);
  const PROPS_TOKEN = `PROPS${randomUUID().replaceAll('-', '')}`;
  const SIG_TOKEN = `SIG${randomUUID().replaceAll('-', '')}`;
  const draft = (propsDigest: string, sigValue: string) =>
    withSignature(serialize(signatureElement(id, documentDigest, propsDigest, sigValue, props, creds), { declaration: false }));

  const draft1 = parse(draft(PROPS_TOKEN, SIG_TOKEN));
  const propsXpath = `//*[@Id='${id}-signedprops']`;
  const propsDigest = sha256(canonicalize(draft1, findById(draft1, `${id}-signedprops`), propsXpath));

  // 3. Sign the canonical SignedInfo, in place.
  const draft2 = parse(draft(propsDigest, SIG_TOKEN));
  const signedInfo = elementsNS(draft2, DSIG_NS, 'SignedInfo')[0]!;
  const signedInfoC14n = canonicalize(draft2, signedInfo, `//*[local-name()='SignedInfo' and namespace-uri()='${DSIG_NS}']`);
  const signatureValue = rsaSign('sha256', Buffer.from(signedInfoC14n, 'utf8'), creds.key).toString('base64');

  const xml = draft(propsDigest, signatureValue);
  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength > MAX_DOCUMENT_BYTES) {
    throw new SignError(`Signed document is ${byteLength} bytes, over the BTS limit of ${MAX_DOCUMENT_BYTES} (code 210)`);
  }
  return { xml, byteLength, signatureId: `${id}-sigvalue`, signingTime };
}
