/**
 * How the installers are built (electron-builder). Kept in a script rather than package.json so the
 * signing settings come from the environment: nothing secret is ever in the repository.
 *
 * Windows signing (any one of these; see README.md):
 *   WIN_SIGN_THUMBPRINT   a certificate in the Windows certificate store, by its SHA-1 thumbprint: a USB
 *                         token, or a cloud signing service that installs its certificate there
 *   WIN_SIGN_COMMAND      a command that signs one file, with {file} where the file goes (Azure Trusted
 *                         Signing, jsign, a provider's own tool)
 *   WIN_PUBLISHER_NAME    the certificate's subject name, exactly. Installed tills then accept an update
 *                         only when it is signed with that name.
 *   Without any of them the installer is built unsigned (fine for trying it, not for businesses).
 *
 * macOS: a Developer ID in the keychain (or CSC_LINK) signs; APPLE_API_KEY, APPLE_API_KEY_ID and
 * APPLE_API_ISSUER notarize. Updates on a Mac need both.
 */

const signing = Boolean(process.env.WIN_SIGN_THUMBPRINT || process.env.WIN_SIGN_COMMAND);
const publisherName = process.env.WIN_PUBLISHER_NAME?.trim();

module.exports = {
  appId: 'bz.floreo.till',
  productName: 'Floreo Till',
  files: ['main.cjs', 'preload.cjs', 'display-preload.cjs', 'network.cjs', 'updates.cjs', 'web/**/*', '!web/**/*.map'],
  directories: { output: 'release' },
  // Writes the update files (latest.yml and the others) beside the installers. The address is only a
  // default: an installed till asks the server it is paired with (updates.cjs).
  publish: [{ provider: 'generic', url: 'https://localhost/downloads/till/' }],
  win: {
    target: ['nsis'],
    artifactName: 'Floreo-Till-Setup-${version}.${ext}',
    signtoolOptions: {
      signingHashAlgorithms: ['sha256'],
      ...(signing && { sign: './scripts/sign-win.cjs' }),
      ...(publisherName && { publisherName: [publisherName] }),
    },
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
  },
  mac: {
    // The .zip is what a Mac updates from; the .dmg is what people download.
    target: ['dmg', 'zip'],
    category: 'public.app-category.business',
    artifactName: 'Floreo-Till-${version}.${ext}',
    hardenedRuntime: true,
    notarize: Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER),
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
    artifactName: 'Floreo-Till-${version}.${ext}',
  },
};
