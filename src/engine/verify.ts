/**
 * Verify the XAdES signature on an ETD.
 *
 * Used to check our own output before sending (a signature bug otherwise only
 * shows up as a BTS rejection, code 240 or 241) and, later, to verify BTS's
 * signed replies. Checks:
 *   - exactly one ds:Signature, inside UBLExtensions/UBLExtension/ExtensionContent (225, 226)
 *   - XMLDSig core validation of both references and the signature value (241)
 *   - a SignedProperties reference, and that xades:CertDigest and IssuerSerial
 *     match the certificate in KeyInfo (240)
 */

import { createHash } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { type CertificateInfo, parseCertificate } from './certificate.ts';
import { DSIG_NS, XADES_NS } from './sign.ts';

const UBL_EXT_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const SIGNED_PROPERTIES_TYPE = 'http://uri.etsi.org/01903#SignedProperties';

export interface VerificationResult {
  valid: boolean;
  errors: string[];
  certificate?: CertificateInfo;
}

function text(parent: Element, ns: string, name: string): string | undefined {
  return parent.getElementsByTagNameNS(ns, name)[0]?.textContent?.trim();
}

function toPem(base64: string): string {
  const body = base64.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export function verifyDocumentSignature(xml: string): VerificationResult {
  const errors: string[] = [];
  const parseErrors: string[] = [];
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') parseErrors.push(msg); } }).parseFromString(xml, 'text/xml');
  } catch {
    return { valid: false, errors: ['Not well-formed XML'] };
  }
  if (parseErrors.length > 0 || !doc.documentElement) return { valid: false, errors: ['Not well-formed XML'] };

  const signatures = Array.from(doc.getElementsByTagNameNS(DSIG_NS, 'Signature'));
  if (signatures.length === 0) return { valid: false, errors: ['No signature found (BTS code 225)'] };
  if (signatures.length > 1) return { valid: false, errors: ['More than one signature (BTS code 226)'] };
  const signature = signatures[0]!;

  const content = signature.parentNode as Element | null;
  const extension = content?.parentNode as Element | null;
  const extensions = extension?.parentNode as Element | null;
  if (
    content?.localName !== 'ExtensionContent' || content.namespaceURI !== UBL_EXT_NS ||
    extension?.localName !== 'UBLExtension' || extensions?.localName !== 'UBLExtensions' ||
    extensions.parentNode !== doc.documentElement
  ) {
    errors.push('Signature must sit in root/UBLExtensions/UBLExtension/ExtensionContent (BTS code 225)');
  }

  const certBase64 = text(signature, DSIG_NS, 'X509Certificate');
  if (!certBase64) return { valid: false, errors: [...errors, 'KeyInfo has no X509Certificate'] };
  let certificate: CertificateInfo;
  try {
    certificate = parseCertificate(toPem(certBase64));
  } catch (e) {
    return { valid: false, errors: [...errors, `KeyInfo certificate is invalid: ${(e as Error).message}`] };
  }

  // XMLDSig core validation.
  try {
    const signed = new SignedXml({ publicCert: toPem(certBase64), getCertFromKeyInfo: () => null });
    signed.loadSignature(signature as never);
    if (!signed.checkSignature(xml)) errors.push('Signature or reference digest is invalid (BTS code 241)');
  } catch (e) {
    errors.push(`Signature or reference digest is invalid (BTS code 241): ${(e as Error).message}`);
  }

  // XAdES checks.
  const references = Array.from(signature.getElementsByTagNameNS(DSIG_NS, 'Reference'));
  if (!references.some((r) => r.getAttribute('URI') === '')) errors.push('No reference over the whole document (URI="")');
  const propsRef = references.find((r) => r.getAttribute('Type') === SIGNED_PROPERTIES_TYPE);
  if (!propsRef) errors.push('No SignedProperties reference (XAdES, BTS code 240)');

  const signedProps = signature.getElementsByTagNameNS(XADES_NS, 'SignedProperties')[0];
  if (!signedProps) {
    errors.push('No xades:SignedProperties (BTS code 240)');
  } else {
    if (propsRef && propsRef.getAttribute('URI') !== `#${signedProps.getAttribute('Id')}`) {
      errors.push('SignedProperties reference does not point at xades:SignedProperties');
    }
    const cert = signedProps.getElementsByTagNameNS(XADES_NS, 'Cert')[0];
    const certDigest = cert && text(cert, DSIG_NS, 'DigestValue');
    if (certDigest !== createHash('sha256').update(certificate.der).digest('base64')) {
      errors.push('xades:CertDigest does not match the KeyInfo certificate');
    }
    if (cert && text(cert, DSIG_NS, 'X509SerialNumber') !== certificate.serialNumber) {
      errors.push('xades:IssuerSerial serial number does not match the certificate');
    }
    if (!signedProps.getElementsByTagNameNS(XADES_NS, 'SignaturePolicyIdentifier')[0]) {
      errors.push('No SignaturePolicyIdentifier (required for XAdES-EPES, BTS code 240)');
    }
  }

  return { valid: errors.length === 0, errors, certificate };
}
