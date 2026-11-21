# Verify an ETD's XMLDSig signature with .NET's System.Security.Cryptography.Xml.SignedXml,
# an implementation independent of the one used to sign. Prints VALID or INVALID.
#
#   powershell -NoProfile -File scripts/verify-signature.ps1 path\to\signed.xml
param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$doc = New-Object System.Xml.XmlDocument
$doc.PreserveWhitespace = $true
$doc.Load((Resolve-Path $Path).Path)

$ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
$ns.AddNamespace('ds', 'http://www.w3.org/2000/09/xmldsig#')
$signatureElement = $doc.SelectSingleNode('//ds:Signature', $ns)
if ($null -eq $signatureElement) { Write-Output 'INVALID: no signature'; exit 1 }

$certBase64 = $signatureElement.SelectSingleNode('.//ds:X509Certificate', $ns).InnerText
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, [Convert]::FromBase64String($certBase64))

$signedXml = New-Object System.Security.Cryptography.Xml.SignedXml($doc)
$signedXml.LoadXml($signatureElement)

# verifySignatureOnly = $true: check the signature and every reference, not the certificate chain
# (the test certificates are not issued by the BTS root).
if ($signedXml.CheckSignature($cert, $true)) { Write-Output 'VALID'; exit 0 }
Write-Output 'INVALID'
exit 1
