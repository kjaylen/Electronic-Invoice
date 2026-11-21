#!/usr/bin/env bash
# Generate throwaway TEST certificates for the signing tests (test/certs/).
#
# They copy the shape of the BTS taxpayer certificate in the manual's Annex I:
# subject "CN=<name> C=BZ TIN=<tin>", the TIN also in extension 1.2.84.2.1,
# country "BZ" in 1.3.6.1.4.1.7.5.2.1, key usage digitalSignature +
# nonRepudiation, extended key usage clientAuth.
#
# These keys are public test data. They are not BTS certificates and BTS
# will reject anything signed with them.
#
#   bash scripts/make-test-certs.sh
set -euo pipefail

# Work with relative paths inside the output folder: on Git Bash for Windows,
# native openssl cannot open /c/... style absolute paths.
export MSYS_NO_PATHCONV=1
OUT="$(cd "$(dirname "$0")/.." && pwd)/test/certs"
mkdir -p "$OUT"
cd "$OUT"
WORK=".work"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT

hex() { printf '%s' "$1" | od -An -tx1 | tr -d ' \n'; }

# Test root CA
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 5475 \
  -subj "/CN=Test Root Certification Authority" \
  -keyout "test-root-ca.key.pem" -out "test-root-ca.cert.pem" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

issue() { # name tin file-prefix
  local name="$1" tin="$2" prefix="$3"
  cat > "$WORK/$prefix.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,nonRepudiation
extendedKeyUsage=critical,clientAuth
subjectKeyIdentifier=hash
1.3.6.1.4.1.7.5.2.1=DER:$(hex BZ)
1.2.84.2.1=DER:$(hex "$tin")
EOF
  openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=$name C=BZ TIN=$tin" \
    -keyout "$prefix.key.pem" -out "$WORK/$prefix.csr" 2>/dev/null
  openssl x509 -req -sha256 -days 3650 -in "$WORK/$prefix.csr" \
    -CA "test-root-ca.cert.pem" -CAkey "test-root-ca.key.pem" -CAcreateserial \
    -extfile "$WORK/$prefix.ext" -out "$prefix.cert.pem" 2>/dev/null
}

issue "CaribFuel" 123456 signer-123456
issue "Other Business" 654321 signer-654321

# TLS server certificate for the fake BTS server in the transport tests.
cat > "$WORK/server.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EOF
openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=localhost" \
  -keyout "server-localhost.key.pem" -out "$WORK/server.csr" 2>/dev/null
openssl x509 -req -sha256 -days 3650 -in "$WORK/server.csr" \
  -CA "test-root-ca.cert.pem" -CAkey "test-root-ca.key.pem" -CAcreateserial \
  -extfile "$WORK/server.ext" -out "server-localhost.cert.pem" 2>/dev/null

# A second, unrelated CA, to test that a server rejects certificates it does not trust.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 5475 \
  -subj "/CN=Untrusted Test Root" \
  -keyout ".work/untrusted.key.pem" -out "untrusted-root-ca.cert.pem" 2>/dev/null

rm -f ./*.srl
echo "Wrote test certificates to $OUT"
