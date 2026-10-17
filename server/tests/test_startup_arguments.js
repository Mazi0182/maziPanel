const assert = require('assert');
const {
  tokenizeArgs,
  splitStartupCommandLine,
  composeStartupCommandLine,
  updateJarInCommandLine,
  applyAikarPreset,
  quoteIfSpaces,
  stripQuotes
} = require('../src/servers/startupArguments');

console.log('====================================================');
console.log('   Startup Arguments Regression & Unit Test Suite    ');
console.log('====================================================\n');

// 1. Basic splitting and composition
{
  console.log('[*] Test 1: Standard JVM flags + jar + server args');
  const input = '-XX:+UseG1GC -XX:MaxGCPauseMillis=200 -jar server.jar nogui';
  const parsed = splitStartupCommandLine(input);
  assert.strictEqual(parsed.jvmFlags, '-XX:+UseG1GC -XX:MaxGCPauseMillis=200');
  assert.strictEqual(parsed.jarFile, 'server.jar');
  assert.strictEqual(parsed.serverArgs, 'nogui');

  const composed = composeStartupCommandLine(parsed.jvmFlags, parsed.jarFile, parsed.serverArgs);
  assert.strictEqual(composed, input);
  console.log('    PASS: Standard split and compose roundtrip succeeded.');
}

// 2. Quoted arguments preservation
{
  console.log('[*] Test 2: Quoted flags in JVM and server args');
  const input = '-Dcustom.prop="hello world" -XX:+UseG1GC -jar "my server.jar" --world "World One" nogui';
  const parsed = splitStartupCommandLine(input);
  assert.strictEqual(parsed.jvmFlags, '-Dcustom.prop="hello world" -XX:+UseG1GC');
  assert.strictEqual(parsed.jarFile, 'my server.jar');
  assert.strictEqual(parsed.serverArgs, '--world "World One" nogui');

  const composed = composeStartupCommandLine(parsed.jvmFlags, parsed.jarFile, parsed.serverArgs);
  assert.strictEqual(composed, input);
  console.log('    PASS: Quoted arguments preserved 100% across boundary.');
}

// 3. No JVM flags (only jar + server args)
{
  console.log('[*] Test 3: No JVM flags');
  const input = '-jar paper.jar nogui --port 25565';
  const parsed = splitStartupCommandLine(input);
  assert.strictEqual(parsed.jvmFlags, '');
  assert.strictEqual(parsed.jarFile, 'paper.jar');
  assert.strictEqual(parsed.serverArgs, 'nogui --port 25565');

  const composed = composeStartupCommandLine(parsed.jvmFlags, parsed.jarFile, parsed.serverArgs);
  assert.strictEqual(composed, input);
  console.log('    PASS: Command without JVM flags handled correctly.');
}

// 4. No server args (only JVM flags + jar)
{
  console.log('[*] Test 4: No server args');
  const input = '-XX:+UseG1GC -jar server.jar';
  const parsed = splitStartupCommandLine(input);
  assert.strictEqual(parsed.jvmFlags, '-XX:+UseG1GC');
  assert.strictEqual(parsed.jarFile, 'server.jar');
  assert.strictEqual(parsed.serverArgs, '');

  const composed = composeStartupCommandLine(parsed.jvmFlags, parsed.jarFile, parsed.serverArgs);
  assert.strictEqual(composed, input);
  console.log('    PASS: Command without server args handled correctly.');
}

// 5. Change JAR preserves split
{
  console.log('[*] Test 5: Changing JAR preserves JVM flags and server args');
  const input = '-XX:+UseG1GC -Dworld="my test" -jar old_server.jar --nogui --port 25565';
  const updated = updateJarInCommandLine(input, 'purpur-1.20.4.jar');
  assert.strictEqual(updated, '-XX:+UseG1GC -Dworld="my test" -jar purpur-1.20.4.jar --nogui --port 25565');

  const parsed = splitStartupCommandLine(updated);
  assert.strictEqual(parsed.jvmFlags, '-XX:+UseG1GC -Dworld="my test"');
  assert.strictEqual(parsed.jarFile, 'purpur-1.20.4.jar');
  assert.strictEqual(parsed.serverArgs, '--nogui --port 25565');
  console.log('    PASS: Changing JAR preserved split and quotes.');
}

// 6. Apply Aikar flags preset preserves JAR and server args
{
  console.log('[*] Test 6: Aikar preset updates only JVM portion');
  const AIKAR_FLAGS = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200';
  const input = '-Xmx2G -Dcustom=true -jar server.jar nogui --port 25565';
  const applied = applyAikarPreset(input, AIKAR_FLAGS, 'server.jar');
  assert.strictEqual(applied, `${AIKAR_FLAGS} -jar server.jar nogui --port 25565`);

  const parsed = splitStartupCommandLine(applied);
  assert.strictEqual(parsed.jvmFlags, AIKAR_FLAGS);
  assert.strictEqual(parsed.jarFile, 'server.jar');
  assert.strictEqual(parsed.serverArgs, 'nogui --port 25565');
  console.log('    PASS: Aikar preset updated only JVM portion and preserved server args.');
}

// 7. Tokenizer tests for child_process spawn
{
  console.log('[*] Test 7: Tokenize args with quotes and spaces');
  const tokens = tokenizeArgs('-XX:+UseG1GC -Dprop="hello world" --world "My World" nogui');
  assert.deepStrictEqual(tokens, [
    '-XX:+UseG1GC',
    '-Dprop=hello world',
    '--world',
    'My World',
    'nogui'
  ]);
  console.log('    PASS: Tokenizer parsed quoted strings correctly.');
}

// 8. Omitted -jar keyword fallback
{
  console.log('[*] Test 8: Fallback when -jar keyword is omitted');
  const input = '-XX:+UseG1GC server.jar nogui';
  const parsed = splitStartupCommandLine(input, 'server.jar');
  assert.strictEqual(parsed.jvmFlags, '-XX:+UseG1GC');
  assert.strictEqual(parsed.jarFile, 'server.jar');
  assert.strictEqual(parsed.serverArgs, 'nogui');
  console.log('    PASS: Fallback without -jar keyword identified jar correctly.');
}

// 9. Empty quoted argument preservation
{
  console.log('[*] Test 9: Preserving empty quoted arguments');
  const tokens = tokenizeArgs('--flag "" --another \'\'');
  assert.deepStrictEqual(tokens, ['--flag', '', '--another', '']);

  const single = tokenizeArgs('""');
  assert.deepStrictEqual(single, ['']);
  console.log('    PASS: Empty quoted arguments preserved without being dropped.');
}

// 10. Escaped quotes
{
  console.log('[*] Test 10: Escaped quotes inside arguments');
  const tokens = tokenizeArgs('-Dmsg=\\"hello\\" --desc "A \\"quoted\\" word"');
  assert.deepStrictEqual(tokens, [
    '-Dmsg="hello"',
    '--desc',
    'A "quoted" word'
  ]);
  console.log('    PASS: Escaped quotes preserved inside and outside tokens.');
}

// 11. Literal Windows backslashes and trailing backslash
{
  console.log('[*] Test 11: Windows paths with backslashes and trailing backslash');
  const tokens = tokenizeArgs('-Dconfig=C:\\Users\\Mert\\config.json --dir "D:\\Game Files\\\\" trailing\\');
  assert.deepStrictEqual(tokens, [
    '-Dconfig=C:\\Users\\Mert\\config.json',
    '--dir',
    'D:\\Game Files\\',
    'trailing\\'
  ]);
  console.log('    PASS: Literal Windows backslashes and trailing backslashes preserved.');
}

// 12. Unclosed quotes syntax validation and error handling
{
  console.log('[*] Test 12: Unclosed quote validation and error handling');
  const { validateStartupCommandLine } = require('../src/servers/startupArguments');

  const validCheck = validateStartupCommandLine('-XX:+UseG1GC -jar server.jar "valid world" nogui');
  assert.strictEqual(validCheck.valid, true);
  assert.strictEqual(validCheck.error, null);

  const invalidCheck = validateStartupCommandLine('-XX:+UseG1GC -jar server.jar "unclosed string');
  assert.strictEqual(invalidCheck.valid, false);
  assert(invalidCheck.error && invalidCheck.error.includes('kapatılmamış'));

  // Test throwOnUnclosed option in tokenizeArgs
  assert.throws(
    () => tokenizeArgs('-XX:+UseG1GC "unclosed', { throwOnUnclosed: true }),
    /kapatılmamış tırnak işareti/
  );
  console.log('    PASS: Unclosed quotes correctly detected and validated.');
}

// 13. Security: Dangerous JVM flags and injection rejection
{
  console.log('[*] Test 13: Dangerous JVM flags and injection rejection');
  const { assertSafeStartupArguments } = require('../src/servers/startupArguments');

  // Normal safe flags (must NOT throw)
  assert.doesNotThrow(() => {
    assertSafeStartupArguments(
      '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+AlwaysPreTouch',
      'nogui --port 25565 --world "World 1"'
    );
  });

  // -javaagent rejected
  assert.throws(
    () => assertSafeStartupArguments('-javaagent:/tmp/evil.jar', 'nogui'),
    /Güvenlik nedeniyle "-javaagent:\/tmp\/evil\.jar" JVM bayrağı reddedildi/
  );

  // -agentlib rejected
  assert.throws(
    () => assertSafeStartupArguments('-agentlib:jdwp=transport=dt_socket', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // -agentpath rejected
  assert.throws(
    () => assertSafeStartupArguments('-agentpath:/lib/evil.so', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // -XX:OnError rejected
  assert.throws(
    () => assertSafeStartupArguments('-XX:OnError="curl http://evil.com"', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // -XX:OnOutOfMemoryError rejected
  assert.throws(
    () => assertSafeStartupArguments('-XX:OnOutOfMemoryError="rm -rf /"', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // -XX:+StartFlightRecording rejected
  assert.throws(
    () => assertSafeStartupArguments('-XX:+StartFlightRecording:filename=/tmp/jfr.jfr', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // -Djava.library.path rejected
  assert.throws(
    () => assertSafeStartupArguments('-Djava.library.path=/tmp', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // -Djava.security.manager rejected
  assert.throws(
    () => assertSafeStartupArguments('-Djava.security.manager=allow', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // -cp / -jar override rejected
  assert.throws(
    () => assertSafeStartupArguments('-cp evil.jar', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // @argfiles rejected
  assert.throws(
    () => assertSafeStartupArguments('@/etc/passwd', 'nogui'),
    /Güvenlik nedeniyle.*bayrağı reddedildi/
  );

  // Admin bypass works when isAdmin: true
  assert.doesNotThrow(() => {
    assertSafeStartupArguments('-javaagent:/opt/valid.jar', 'nogui', { isAdmin: true });
  });

  console.log('    PASS: All dangerous JVM flags and command injection vectors rejected with Turkish errors.');
}

console.log('\n====================================================');
console.log('   ALL STARTUP ARGUMENT TESTS PASSED (100%)');
console.log('====================================================');
