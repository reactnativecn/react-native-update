from pathlib import Path
pending = {}
def replace(path, old, new, count=1):
    s = pending.get(path, Path(path).read_text())
    if s.count(old) != count:
        raise RuntimeError(f'{path}: match count {s.count(old)} for {old[:100]!r}')
    pending[path] = s.replace(old, new)
A='android/src/main/java/cn/reactnative/modules/update/'
H='harmony/pushy/src/main/ets/'
I='ios/RCTPushy/'
replace(A+'UpdateContext.java', '''    void setNativeConfig(String config) {
        synchronized (commitLock) {
            if (config.equals(sp.getString(NativeCheckOrchestrator.KEY_CONFIG, null))) {
                return;
            }
            // Also invalidate on a failed persistence attempt: never allow an
            // older round to commit over uncertain configuration state.
            resetGeneration.incrementAndGet();
            SharedPreferences.Editor editor = sp.edit();
            editor.putString(NativeCheckOrchestrator.KEY_CONFIG, config);
            editor.remove(NativeCheckOrchestrator.KEY_RESP_CACHE);
            NativeCheckOrchestrator.markJsCheckCompleted(null);
            persistEditorOrThrow(editor, "configure native update");
        }
        NativeCheckOrchestrator.onConfigured(this);
    }''', '''    private static final java.util.concurrent.atomic.AtomicLong nativeConfigGeneration =
        new java.util.concurrent.atomic.AtomicLong(0);

    static long getNativeConfigGeneration() {
        return nativeConfigGeneration.get();
    }

    void setNativeConfig(String config) {
        synchronized (commitLock) {
            boolean changed = !config.equals(sp.getString(NativeCheckOrchestrator.KEY_CONFIG, null));
            SharedPreferences.Editor editor = sp.edit();
            if (changed) {
                // Also invalidate on a failed persistence attempt: an older
                // round must not commit over uncertain configuration state.
                resetGeneration.incrementAndGet();
                nativeConfigGeneration.incrementAndGet();
                editor.remove(NativeCheckOrchestrator.KEY_RESP_CACHE);
                NativeCheckOrchestrator.markJsCheckCompleted(null);
            }
            // A native-only first launch needs a stable gray-release identity
            // before JS initializes. Never replace an existing installation ID.
            String uuid = sp.getString("uuid", null);
            if (uuid == null || uuid.isEmpty()) {
                editor.putString("uuid", java.util.UUID.randomUUID().toString());
            }
            editor.putString(NativeCheckOrchestrator.KEY_CONFIG, config);
            // Persist even an equal value: a previous commit may have updated
            // SharedPreferences memory but failed to write its file.
            persistEditorOrThrow(editor, "configure native update");
        }
        NativeCheckOrchestrator.onConfigured(this);
    }''')
replace(A+'NativeCheckOrchestrator.java', '    private static volatile long roundGeneration = -1;\n', '    private static volatile long roundGeneration = -1;\n    private static volatile long roundConfigGeneration = -1;\n')
replace(A+'NativeCheckOrchestrator.java', '        if (!configJson.equals(roundConfigJson) || !configJson.equals(context.getKv(KEY_CONFIG))) {', '        if (roundConfigGeneration != UpdateContext.getNativeConfigGeneration()\n            || !configJson.equals(roundConfigJson) || !configJson.equals(context.getKv(KEY_CONFIG))) {')
replace(A+'NativeCheckOrchestrator.java', '        roundGeneration = resetGeneration;\n', '        roundGeneration = resetGeneration;\n        roundConfigGeneration = UpdateContext.getNativeConfigGeneration();\n')

replace(I+'RCTPushy.mm', 'static uint64_t pushyHostRoundGeneration = 0;\n', '''static uint64_t pushyHostRoundGeneration = 0;
static std::atomic<uint64_t> pushyNativeConfigGeneration{0};
static uint64_t pushyHostRoundConfigGeneration = 0;
''')
replace(I+'RCTPushy.mm', '''        if ([[defaults stringForKey:keyNativeConfig] isEqualToString:config]) {
            return;
        }
        // The same generation protects reset and replacement of the request
        // identity/policy, including a late crash-rescue activation.
        pushyResetGeneration.fetch_add(1);
        [defaults setObject:config forKey:keyNativeConfig];
        [defaults removeObjectForKey:keyNativeCheckCache];
        [self markJsCheckCompleted:nil];''', '''        if ([defaults stringForKey:keyUuid].length == 0) {
            [defaults setObject:[NSUUID UUID].UUIDString forKey:keyUuid];
        }
        if ([[defaults stringForKey:keyNativeConfig] isEqualToString:config]) {
            return;
        }
        // The same generation protects reset and replacement of the request
        // identity/policy, including a late crash-rescue activation.
        pushyResetGeneration.fetch_add(1);
        pushyNativeConfigGeneration.fetch_add(1);
        [defaults setObject:config forKey:keyNativeConfig];
        [defaults removeObjectForKey:keyNativeCheckCache];
        [self markJsCheckCompleted:nil];''')
replace(I+'RCTPushy.mm', '    if (![configJson isEqualToString:pushyHostRoundConfig]\n', '    if (pushyHostRoundConfigGeneration != pushyNativeConfigGeneration.load()\n        || ![configJson isEqualToString:pushyHostRoundConfig]\n')
replace(I+'RCTPushy.mm', '    pushyHostRoundGeneration = resetGeneration;\n', '    pushyHostRoundGeneration = resetGeneration;\n    pushyHostRoundConfigGeneration = pushyNativeConfigGeneration.load();\n')

replace(H+'UpdateContext.ts', '  public setNativeConfig(config: string): Promise<void> {\n', '''  private static nativeConfigGeneration: number = 0;

  public getNativeConfigGeneration(): number {
    return UpdateContext.nativeConfigGeneration;
  }

  public setNativeConfig(config: string): Promise<void> {
    if (!this.getKv('uuid')) {
      this.preferences.putSync('uuid', util.generateRandomUUID());
    }
''')
replace(H+'UpdateContext.ts', '''      // Also guards A -> B -> A replacements and late download commits.
      UpdateContext.resetGeneration += 1;''', '''      // Also guards A -> B -> A replacements and late download commits.
      UpdateContext.resetGeneration += 1;
      UpdateContext.nativeConfigGeneration += 1;''')
replace(H+'NativeCheckOrchestrator.ts', 'let roundGeneration = -1;\n', 'let roundGeneration = -1;\nlet roundConfigGeneration = -1;\n')
replace(H+'NativeCheckOrchestrator.ts', '  roundGeneration = resetGeneration;\n', '  roundGeneration = resetGeneration;\n  roundConfigGeneration = context.getNativeConfigGeneration();\n')
replace(H+'NativeCheckOrchestrator.ts', '  if (configJson !== roundConfigJson || configJson !== context.getKv(KEY_CONFIG)) {', '  if (roundConfigGeneration !== context.getNativeConfigGeneration()\n      || configJson !== roundConfigJson || configJson !== context.getKv(KEY_CONFIG)) {')
replace('src/__tests__/nativeHostApi.test.ts', '    getResetGeneration: () => state.generation,\n', '    getResetGeneration: () => state.generation,\n    getNativeConfigGeneration: () => 0,\n')
replace('src/__tests__/nativeConfiguration.test.ts', "      KEY_CONFIG: 'nativeConfig',\n", "      util: { generateRandomUUID: () => 'native-installation-id' },\n      KEY_CONFIG: 'nativeConfig',\n")
replace('src/__tests__/nativeConfiguration.test.ts', "    expect(h.values.has('hash_old')).toBe(false);\n", "    expect(h.values.has('hash_old')).toBe(false);\n    expect(h.values.get('uuid')).toBe('native-installation-id');\n")

path='src/__tests__/nativeHostApi.test.ts'
s = pending[path]
s += '''

test('automatic preflight without configuration leaves a round for later native provisioning', async () => {
  const h = harness();
  h.values.delete('nativeConfig');
  h.initialize();
  for (const timer of h.timers) timer();
  await Promise.resolve();
  expect(h.state.checks).toBe(0);
  h.values.set('nativeConfig', JSON.stringify({ appKey: 'native-first-app', afterDownload: 'setNeedUpdate' }));
  h.state.decision = { action: 'download', hash: 'v2', activate: true };
  expect((await h.check()).activated).toBe(true);
  expect(h.state.checks).toBe(1);
});

test('configuration replacement during an update cancels its returned snapshot', async () => {
  const h = harness();
  h.initialize();
  h.state.decision = { action: 'download', hash: 'v2', activate: true };
  h.state.beforeResponse = async () => {
    h.values.set('nativeConfig', JSON.stringify({ appKey: 'replacement' }));
    h.state.generation += 1;
  };
  expect(await h.check()).toEqual(nativeUpdateResult('cancelled', 'config_changed'));
});
'''
pending[path] = s
for path, content in pending.items():
    Path(path).write_text(content)
print('Applied native-first identity and regression follow-ups')
