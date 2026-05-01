import { describe, expect, test } from 'bun:test';

describe('I18n', () => {
  // Use a helper function to import the real implementation
  // since `../i18n` is globally mocked in `setup.ts`
  const getRealI18n = async () => {
    // Generate a random cache-buster so we get a fresh instance if needed,
    // although singleton is usually fine, the `setup.ts` mock needs to be bypassed.
    const cacheKey = 'real';
    const module = await import(`../i18n?${cacheKey}`);
    return { I18n: module.I18n, i18nSingleton: module.default };
  };

  test('setLocale and getLocale', async () => {
    const { I18n } = await getRealI18n();
    const i18n = new I18n();

    expect(i18n.getLocale()).toBe('en'); // Default is 'en'

    i18n.setLocale('zh');
    expect(i18n.getLocale()).toBe('zh');

    i18n.setLocale('en');
    expect(i18n.getLocale()).toBe('en');
  });

  test('basic translations and fallback', async () => {
    const { I18n } = await getRealI18n();
    const i18n = new I18n();

    // English translation
    i18n.setLocale('en');
    expect(i18n.t('checking_update')).toBe('Checking for updates...');

    // Chinese translation
    i18n.setLocale('zh');
    expect(i18n.t('checking_update')).toBe('正在检查更新...');

    // Fallback logic
    // Add translation only to 'zh', check if 'en' falls back to 'zh'
    i18n.addTranslations('zh', { 'only_in_zh': '中文专属' });
    i18n.setLocale('en');
    expect(i18n.t('only_in_zh' as any)).toBe('中文专属');

    // Add translation only to 'en', check if 'zh' falls back to 'en'
    i18n.addTranslations('en', { 'only_in_en': 'English Only' });
    i18n.setLocale('zh');
    expect(i18n.t('only_in_en' as any)).toBe('English Only');

    // Key missing in both locales
    expect(i18n.t('missing_key' as any)).toBe('missing_key');
  });

  test('string interpolation', async () => {
    const { I18n } = await getRealI18n();
    const i18n = new I18n();

    i18n.setLocale('en');

    // Normal interpolation
    expect(i18n.t('download_progress', { progress: 50 })).toBe('Download progress: 50%');

    // Multiple interpolations
    expect(i18n.t('retry_count', { count: 1, max: 3 })).toBe('Retry attempt: 1/3');

    // Interpolation with missing values (should leave placeholder as is)
    expect(i18n.t('download_progress')).toBe('Download progress: {{progress}}%');

    // Invalid interpolation syntax (spaces) are ignored
    i18n.addTranslations('en', { 'invalid_syntax': 'Test {{ key }} here' });
    expect(i18n.t('invalid_syntax' as any, { key: 'value' })).toBe('Test {{ key }} here');
  });

  test('addTranslations', async () => {
    const { I18n } = await getRealI18n();
    const i18n = new I18n();

    i18n.addTranslations('en', { 'new_key': 'New Value' });
    i18n.setLocale('en');

    expect(i18n.t('new_key' as any)).toBe('New Value');
  });

  test('singleton export', async () => {
    const { i18nSingleton } = await getRealI18n();

    // Verify it works
    expect(i18nSingleton.getLocale()).toBeDefined();
    expect(i18nSingleton.t('checking_update')).toBeDefined();
  });
});
