const fs = require('fs');

async function main() {
  console.log('=== Running End-to-End Test for maziPanel ===');

  // 1. Port Check for free port 25588
  const portRes = await fetch('http://127.0.0.1:8080/api/servers/check-port?port=25588');
  const portData = await portRes.json();
  console.log('Port 25588 check result:', portData);
  if (!portData.available) {
    throw new Error('Expected port 25588 to be available!');
  }

  // 2. Server creation test
  console.log('\n--- Creating Server ---');
  const createRes = await fetch('http://127.0.0.1:8080/api/servers/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'http://127.0.0.1:8080',
      'Referer': 'http://127.0.0.1:8080/'
    },
    body: JSON.stringify({
      name: 'E2E-Purpur-Test',
      type: 'purpur',
      version: '26.3',
      port: 25588,
      ramMin: '2G',
      ramMax: '4G'
    })
  });

  console.log('Server creation HTTP status:', createRes.status);
  const server = await createRes.json();
  console.log('Created server ID:', server.id, 'Name:', server.name);
  if (createRes.status !== 201 || !server.id) {
    throw new Error(`Failed to create server: ${JSON.stringify(server)}`);
  }

  // 3. Verify server in list
  const listRes = await fetch('http://127.0.0.1:8080/api/servers');
  const servers = await listRes.json();
  const found = servers.find((s) => s.id === server.id);
  if (!found) {
    throw new Error('Created server not found in /api/servers');
  }
  console.log('Verified server in server list:', found.name);

  // 4. Create Backup test (tar.gz)
  console.log('\n--- Creating Backup ---');
  const backupRes = await fetch('http://127.0.0.1:8080/api/backups', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'http://127.0.0.1:8080',
      'Referer': 'http://127.0.0.1:8080/'
    },
    body: JSON.stringify({
      serverId: server.id,
      name: 'test-backup-e2e',
      compression: 'gzip',
      exclusions: ['logs', 'cache']
    })
  });

  console.log('Backup creation HTTP status:', backupRes.status);
  const backup = await backupRes.json();
  console.log('Created backup:', backup.name, 'File:', backup.filename, 'Size:', backup.sizeFormatted);
  if (backupRes.status !== 201 || !backup.id) {
    throw new Error(`Failed to create backup: ${JSON.stringify(backup)}`);
  }

  // 5. List backups
  const backupsListRes = await fetch(`http://127.0.0.1:8080/api/backups?serverId=${server.id}`);
  const backupsList = await backupsListRes.json();
  console.log(`Backups count for server ${server.id}:`, backupsList.length);
  if (backupsList.length === 0) {
    throw new Error('No backups listed for created server');
  }

  // 6. Delete backup
  console.log('\n--- Deleting Backup ---');
  const delBackupRes = await fetch(`http://127.0.0.1:8080/api/backups/${backup.id}`, {
    method: 'DELETE',
    headers: {
      'Origin': 'http://127.0.0.1:8080',
      'Referer': 'http://127.0.0.1:8080/'
    }
  });
  console.log('Delete backup status:', delBackupRes.status);
  const delBackupData = await delBackupRes.json();
  console.log('Delete backup response:', delBackupData);

  // 7. Cleanup server
  console.log('\n--- Cleaning up Server ---');
  const delServerRes = await fetch(`http://127.0.0.1:8080/api/servers/${server.id}`, {
    method: 'DELETE',
    headers: {
      'Origin': 'http://127.0.0.1:8080',
      'Referer': 'http://127.0.0.1:8080/'
    }
  });
  console.log('Delete server status:', delServerRes.status);
  if (fs.existsSync(server.directory)) {
    fs.rmSync(server.directory, { recursive: true, force: true });
  }

  console.log('\n=== ALL E2E TESTS COMPLETED SUCCESSFULLY! ===');
}

main().catch((err) => {
  console.error('Fatal error in E2E test:', err);
  process.exit(1);
});
