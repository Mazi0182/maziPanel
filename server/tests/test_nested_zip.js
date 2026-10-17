const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const zipImporter = require('../src/servers/zipImporter');
const serverRegistry = require('../src/servers/serverRegistry');

async function testNestedZipWithMetadata() {
  console.log('--- Testing Nested ZIP Unwrapping with macOS/Windows Metadata ---');

  const zip = new AdmZip();
  // Simulate a ZIP produced on macOS where root contains __MACOSX and .DS_Store alongside the server directory
  zip.addFile('__MACOSX/._server.properties', Buffer.from('metadata'));
  zip.addFile('.DS_Store', Buffer.from('desktop file'));
  zip.addFile('my-server-root/server.properties', Buffer.from('server-port=25577\nmotd=Nested Purpur Server\n'));
  zip.addFile('my-server-root/purpur-1.21.1.jar', Buffer.from('PK\x05\x06' + '\x00'.repeat(18)));
  zip.addFile('my-server-root/plugins/plugin.txt', Buffer.from('plugin contents'));

  const tempZipPath = '/mazideveloper/temp/test_nested_archive.zip';
  zip.writeZip(tempZipPath);

  console.log('[*] Importing nested ZIP archive...');
  const result = await zipImporter.importZip(tempZipPath, 'nested-test-server');

  console.log(`[+] Server registered: ${result.server.id}`);
  console.log(`[+] Detected JAR: ${result.server.jarFile}`);
  console.log(`[+] Detected Port: ${result.server.port}`);
  console.log(`[+] Server Directory: ${result.server.directory}`);

  if (result.server.jarFile !== 'purpur-1.21.1.jar') {
    throw new Error(`Expected purpur-1.21.1.jar, got: ${result.server.jarFile}`);
  }
  if (result.server.port !== 25577) {
    throw new Error(`Expected port 25577, got: ${result.server.port}`);
  }

  // Verify files are at the root of result.server.directory, not nested
  const rootFiles = fs.readdirSync(result.server.directory);
  console.log('[+] Root files in imported directory:', rootFiles);

  if (!rootFiles.includes('purpur-1.21.1.jar') || !rootFiles.includes('server.properties')) {
    throw new Error('Server files were not properly unwrapped to root directory!');
  }

  // Cleanup
  serverRegistry.delete(result.server.id);
  fs.rmSync(result.server.directory, { recursive: true, force: true });
  console.log('[+] Nested ZIP import test completed successfully with 100% PASS!');

  // Test Zip Slip rejection in zipImporter
  console.log('[*] Testing Zip-Slip rejection in zipImporter...');
  const maliciousZip = new AdmZip();
  maliciousZip.addFile('dummy.txt', Buffer.from('malicious content'));
  maliciousZip.getEntries()[0].entryName = '../../evil_slip.txt';
  const evilZipPath = path.join(require('../config').DATA_DIR, 'test_slip.zip');
  maliciousZip.writeZip(evilZipPath);

  let slipBlocked = false;
  try {
    await zipImporter.importZip(evilZipPath, 'evil-server');
  } catch (err) {
    if (err.message.includes('Zip Slip')) {
      slipBlocked = true;
    }
  } finally {
    try { if (fs.existsSync(evilZipPath)) fs.unlinkSync(evilZipPath); } catch (e) {}
  }
  if (!slipBlocked) {
    throw new Error('Zip-Slip archive was NOT blocked by zipImporter!');
  }
  console.log('[+] Zip-Slip blocked successfully with 100% PASS!');
}

if (require.main === module) {
  testNestedZipWithMetadata()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Test Failed:', err);
      process.exit(1);
    });
}

module.exports = { testNestedZipWithMetadata };
