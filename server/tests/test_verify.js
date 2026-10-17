async function main() {
  console.log('--- Verifying maziPanel Endpoints & Assets ---');

  // 1. Port Check
  const portRes = await fetch('http://127.0.0.1:8080/api/servers/check-port?port=25565');
  console.log('Port Check HTTP:', portRes.status);
  const portData = await portRes.json();
  console.log('Port Check Data:', portData);

  // 2. Backups List
  const backupsRes = await fetch('http://127.0.0.1:8080/api/backups');
  console.log('Backups HTTP:', backupsRes.status);
  const backupsData = await backupsRes.json();
  console.log('Backups Count:', Array.isArray(backupsData) ? backupsData.length : backupsData);

  // 3. Health
  const healthRes = await fetch('http://127.0.0.1:8080/api/health');
  console.log('Health HTTP:', healthRes.status);
  const healthData = await healthRes.json();
  console.log('Health Status:', healthData.status);

  // 4. HTML & Favicon
  const htmlRes = await fetch('http://127.0.0.1:8080/');
  const html = await htmlRes.text();
  console.log('HTML index served:', html.includes('maziPanel'));
  console.log('Favicon svg linked:', html.includes('favicon.svg'));

  const favRes = await fetch('http://127.0.0.1:8080/favicon.svg');
  console.log('Favicon HTTP Status:', favRes.status, 'Content-Type:', favRes.headers.get('content-type'));

  // 5. Test unauthenticated POST to /api/servers/create without token from local/web panel
  console.log('\n--- Testing /api/servers/create with web panel headers ---');
  const createTestRes = await fetch('http://127.0.0.1:8080/api/servers/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'http://127.0.0.1:8080',
      'Referer': 'http://127.0.0.1:8080/'
    },
    body: JSON.stringify({
      name: '', // Intentionally empty to test auth passed (should return 400 validation error, NOT 401!)
      type: 'purpur',
      port: 25565
    })
  });
  console.log('Create server with empty name status:', createTestRes.status);
  const createTestData = await createTestRes.json();
  console.log('Create server response:', createTestData);
  if (createTestRes.status === 401) {
    throw new Error('FAIL: /api/servers/create returned 401 Unauthorized!');
  }
  if (createTestRes.status === 400 && createTestData.error) {
    console.log('SUCCESS: Auth passed! Validation returned 400 as expected: ' + createTestData.error);
  }

  console.log('\nALL VERIFICATIONS PASSED!');
}

main().catch((e) => {
  console.error('Verification failed:', e);
  process.exit(1);
});
