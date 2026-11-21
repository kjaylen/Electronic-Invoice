/**
 * Taxpayer signing certificates (manual 8.1).
 *
 * A BTS certificate is X.509 v3, issued by the EFDR root CA, with the
 * taxpayer's TIN in the subject (e.g. CN=Tasty Bytes C=BZ TIN=234567) and
 * also in a private extension, OID 1.2.84.2.1. The same certificate signs
 * documents and authenticates the TLS connection.
 *
 * Names are read straight from the DER encoding and formatted the way .NET's
 * X500DistinguishedName does (reversed RDN order, ", " separator, values with
 * special characters quoted), which is what BTS's own signatures show, e.g.
 * CN="Belize Tax Service C=BZ TIN=000001".
 *
 * Security: private keys stay in memory as KeyObjects. Nothing here logs or
 * returns key material.
 */

import { createHash, createPrivateKey, type KeyObject, X509Certificate } from 'node:crypto';

export class CertificateError extends Error {
  override name = 'CertificateError';
  /** The BTS rejection code this check prevents, when there is one. */
  readonly btsCode: number | undefined;
  constructor(message: string, btsCode?: number) {
    super(message);
    this.btsCode = btsCode;
  }
}

export interface CertificateInfo {
  der: Buffer;
  derBase64: string;
  /** SHA-256 of the DER encoding, Base64. Goes in xades:CertDigest. */
  sha256Base64: string;
  /** Issuer name, .NET style. Goes in X509IssuerName. */
  issuerName: string;
  /** Subject name, .NET style. Goes in X509SubjectName. */
  subjectName: string;
  /** Serial number in decimal. Goes in X509SerialNumber. */
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  /** Taxpayer TIN from extension 1.2.84.2.1, or "TIN=" in the subject; null if absent. */
  tin: string | null;
}

export interface SigningCredentials {
  key: KeyObject;
  certificate: CertificateInfo;
}

const TIN_EXTENSION_OID = '1.2.84.2.1';

const ATTRIBUTE_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'SERIALNUMBER',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'S',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'T',
  '2.5.4.42': 'G',
  '1.2.840.113549.1.9.1': 'E',
  '0.9.2342.19200300.100.1.25': 'DC',
};

// ---------- minimal DER reader ----------

interface Tlv {
  tag: number;
  contentStart: number;
  end: number;
}

function readTlv(buf: Buffer, offset: number): Tlv {
  if (offset + 2 > buf.length) throw new CertificateError('Certificate is truncated');
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let pos = offset + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4) throw new CertificateError('Unsupported DER length');
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[pos++]!;
  }
  const end = pos + len;
  if (end > buf.length) throw new CertificateError('Certificate is truncated');
  return { tag, contentStart: pos, end };
}

function childrenOf(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = parent.contentStart;
  while (pos < parent.end) {
    const t = readTlv(buf, pos);
    out.push(t);
    pos = t.end;
  }
  return out;
}

function decodeOid(bytes: Buffer): string {
  const parts: number[] = [];
  let value = 0;
  for (const b of bytes) {
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  const first = parts.shift() ?? 0;
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...parts].join('.');
}

function decodeString(buf: Buffer, t: Tlv): string {
  const bytes = buf.subarray(t.contentStart, t.end);
  switch (t.tag) {
    case 0x1e: // BMPString, UTF-16BE
      return Buffer.from(bytes).swap16().toString('utf16le');
    case 0x14: // TeletexString, treat as Latin-1
      return bytes.toString('latin1');
    default: // UTF8String, PrintableString, IA5String
      return bytes.toString('utf8');
  }
}

type Rdn = Array<{ oid: string; value: string }>;

function decodeName(buf: Buffer, name: Tlv): Rdn[] {
  return childrenOf(buf, name).map((set) =>
    childrenOf(buf, set).map((atv) => {
      const [oid, value] = childrenOf(buf, atv);
      if (!oid || !value) throw new CertificateError('Malformed distinguished name');
      return { oid: decodeOid(buf.subarray(oid.contentStart, oid.end)), value: decodeString(buf, value) };
    }),
  );
}

/** .NET X500DistinguishedName.Name formatting. */
export function formatDistinguishedName(rdns: Rdn[]): string {
  const quote = (v: string) =>
    /[,+="\n<>#;]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
  return [...rdns]
    .reverse()
    .map((rdn) => rdn.map(({ oid, value }) => `${ATTRIBUTE_NAMES[oid] ?? `OID.${oid}`}=${quote(value)}`).join(' + '))
    .join(', ');
}

function decodeExtensions(buf: Buffer, tbsChildren: Tlv[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const wrapper = tbsChildren.find((t) => t.tag === 0xa3);
  if (!wrapper) return out;
  const [sequence] = childrenOf(buf, wrapper);
  if (!sequence) return out;
  for (const ext of childrenOf(buf, sequence)) {
    const parts = childrenOf(buf, ext);
    const oid = parts[0];
    const value = parts[parts.length - 1]; // skip the optional "critical" BOOLEAN
    if (oid && value && value.tag === 0x04) {
      out.set(decodeOid(buf.subarray(oid.contentStart, oid.end)), buf.subarray(value.contentStart, value.end));
    }
  }
  return out;
}

// ---------- public API ----------

export function parseCertificate(pem: string): CertificateInfo {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(pem);
  } catch {
    throw new CertificateError('Not a valid X.509 certificate');
  }
  const der = Buffer.from(x509.raw);
  const cert = readTlv(der, 0);
  const [tbs] = childrenOf(der, cert);
  if (!tbs) throw new CertificateError('Malformed certificate');
  const tbsChildren = childrenOf(der, tbs);
  // tbsCertificate: [0] version?, serialNumber, signature, issuer, validity, subject, ...
  const offset = tbsChildren[0]?.tag === 0xa0 ? 1 : 0;
  const issuer = tbsChildren[offset + 2];
  const subject = tbsChildren[offset + 4];
  if (!issuer || !subject) throw new CertificateError('Malformed certificate');
  const subjectRdns = decodeName(der, subject);

  const extensions = decodeExtensions(der, tbsChildren);
  const tinExtension = extensions.get(TIN_EXTENSION_OID)?.toString('utf8').trim();
  const cn = subjectRdns.flat().find((a) => a.oid === '2.5.4.3')?.value ?? '';
  const tinInSubject = /\bTIN=(\d+)/.exec(cn)?.[1];

  return {
    der,
    derBase64: der.toString('base64'),
    sha256Base64: createHash('sha256').update(der).digest('base64'),
    issuerName: formatDistinguishedName(decodeName(der, issuer)),
    subjectName: formatDistinguishedName(subjectRdns),
    serialNumber: BigInt(`0x${x509.serialNumber}`).toString(10),
    validFrom: new Date(x509.validFrom),
    validTo: new Date(x509.validTo),
    tin: (tinExtension && /^\d+$/.test(tinExtension) ? tinExtension : tinInSubject) ?? null,
  };
}

/**
 * Load a taxpayer's key and certificate (PEM) and check that they belong
 * together. Encrypted keys need the passphrase.
 */
export function loadSigningCredentials(privateKeyPem: string, certificatePem: string, passphrase?: string): SigningCredentials {
  let key: KeyObject;
  try {
    key = createPrivateKey(passphrase === undefined ? privateKeyPem : { key: privateKeyPem, passphrase });
  } catch {
    // Never echo the key or the underlying error, which can include key material.
    throw new CertificateError('Could not read the private key (wrong format or passphrase)');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new CertificateError('BTS signatures use RSA-SHA256; the private key must be RSA');
  }
  const certificate = parseCertificate(certificatePem);
  if (!new X509Certificate(certificatePem).checkPrivateKey(key)) {
    throw new CertificateError('The private key does not match the certificate');
  }
  return { key, certificate };
}

/** Refuse to sign with a certificate BTS would reject. */
export function assertCertificateUsable(cert: CertificateInfo, check: { tin: string; at: Date }): void {
  if (check.at < cert.validFrom) {
    throw new CertificateError(`Certificate is not valid until ${cert.validFrom.toISOString()}`, 231);
  }
  if (check.at > cert.validTo) {
    throw new CertificateError(`Certificate expired on ${cert.validTo.toISOString()}`, 231);
  }
  if (cert.tin === null) {
    throw new CertificateError('Certificate carries no TIN', 243);
  }
  if (cert.tin !== check.tin) {
    throw new CertificateError(`Certificate TIN ${cert.tin} differs from the supplier TIN ${check.tin}`, 243);
  }
}
