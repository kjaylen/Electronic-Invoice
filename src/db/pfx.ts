/**
 * Read a PKCS#12 (.pfx / .p12) file, the format certificate portals usually
 * hand out, into the PEM key and certificate the rest of the system uses.
 * Node's crypto cannot read PKCS#12, so this uses node-forge.
 *
 * If the file holds a chain, the certificate whose public key matches the
 * private key is the one returned.
 */

import forge from 'node-forge';

const OIDS = {
  shroudedKey: forge.pki.oids.pkcs8ShroudedKeyBag as string,
  key: forge.pki.oids.keyBag as string,
  cert: forge.pki.oids.certBag as string,
};

export class PfxError extends Error {
  override name = 'PfxError';
}

export function pfxToPem(pfx: Buffer, password: string): { certificatePem: string; privateKeyPem: string } {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    // Never echo forge's message: it can include file contents.
    throw new PfxError('Could not open the certificate file: check the file and its password');
  }
  const keyBags: forge.pkcs12.Bag[] = [
    ...(p12.getBags({ bagType: OIDS.shroudedKey })[OIDS.shroudedKey] ?? []),
    ...(p12.getBags({ bagType: OIDS.key })[OIDS.key] ?? []),
  ];
  const certBags: forge.pkcs12.Bag[] = p12.getBags({ bagType: OIDS.cert })[OIDS.cert] ?? [];
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new PfxError('The certificate file contains no private key');
  const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => Boolean(c));
  const matching = certs.find((c: forge.pki.Certificate) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return pub.n?.equals(key.n) && pub.e?.equals(key.e);
  });
  if (!matching) throw new PfxError('The certificate file contains no certificate for its private key');
  return {
    certificatePem: forge.pki.certificateToPem(matching),
    privateKeyPem: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))),
  };
}
