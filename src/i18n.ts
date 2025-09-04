import zhTranslations from './locales/zh';
import enTranslations from './locales/en';

type TranslationKey = keyof typeof zhTranslations | keyof typeof enTranslations;
type TranslationValues = Record<string, string | number>;

class I18n {
  private currentLocale: 'zh' | 'en' = 'en';
  private translations = {
    zh: zhTranslations,
    en: enTranslations,
  };

  /**
   * Set locale directly
   * @param locale - 'zh' or 'en'
   */
  setLocale(locale: 'zh' | 'en') {
    this.currentLocale = locale;
  }

  /**
   * Get current locale
   */
  getLocale(): 'zh' | 'en' {
    return this.currentLocale;
  }

  /**
   * Translate a key with optional interpolation
   * @param key - Translation key
   * @param values - Values for interpolation (optional)
   * @returns Translated string with interpolated values
   */
  t(key: TranslationKey, values?: TranslationValues): string {
    const translation =
      this.translations[this.currentLocale][
        key as keyof (typeof this.translations)[typeof this.currentLocale]
      ];

    if (!translation) {
      // Fallback to the other locale if key not found
      const fallbackLocale = this.currentLocale === 'zh' ? 'en' : 'zh';
      const fallbackTranslation =
        this.translations[fallbackLocale][
          key as keyof (typeof this.translations)[typeof fallbackLocale]
        ];

      if (!fallbackTranslation) {
        // If still not found, return the key itself
        return String(key);
      }

      return this.interpolate(fallbackTranslation, values);
    }

    return this.interpolate(translation, values);
  }

  /**
   * Interpolate values into a string template
   * Supports {{key}} syntax
   * @param template - String template with {{key}} placeholders
   * @param values - Values to interpolate
   * @returns Interpolated string
   */
  private interpolate(template: string, values?: TranslationValues): string {
    if (!values) {
      return template;
    }

    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = values[key];
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Add or update translations for a specific locale
   * @param locale - Target locale
   * @param translations - Translation object to merge
   */
  addTranslations(locale: 'zh' | 'en', translations: Record<string, string>) {
    this.translations[locale] = {
      ...this.translations[locale],
      ...translations,
    };
  }
}

// Create singleton instance
const i18n = new I18n();

// Export both the instance and the class for flexibility
export { i18n, I18n };
export default i18n;

/**
 * Usage examples:
 *
 * // Direct locale setting (new preferred method)
 * i18n.setLocale('zh'); // Chinese
 * i18n.setLocale('en'); // English
 *
 * // Get translations
 * i18n.t('checking_update'); // Based on current locale
 * i18n.t('download_progress', { progress: 50 }); // With interpolation
 */
