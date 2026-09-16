import { describe, it, expect, beforeEach } from 'vitest';

describe('GUI Internationalization (i18n)', () => {
  let I18N: any;

  beforeEach(async () => {
    // Import i18n module
    await import('../src/gui/renderer/i18n.js');
    I18N = (globalThis as any).I18N;
  });

  it('exports valid TRANSLATIONS object with zh-CN and en-US', () => {
    expect(I18N).toBeDefined();
    expect(I18N.TRANSLATIONS).toBeDefined();
    expect(I18N.TRANSLATIONS['zh-CN']).toBeDefined();
    expect(I18N.TRANSLATIONS['en-US']).toBeDefined();
  });

  it('has exact key parity between zh-CN and en-US with non-empty values', () => {
    const zhKeys = Object.keys(I18N.TRANSLATIONS['zh-CN']).sort();
    const enKeys = Object.keys(I18N.TRANSLATIONS['en-US']).sort();

    expect(zhKeys.length).toBeGreaterThan(50);
    expect(zhKeys).toEqual(enKeys);

    for (const key of zhKeys) {
      expect(I18N.TRANSLATIONS['zh-CN'][key]).toBeTruthy();
      expect(typeof I18N.TRANSLATIONS['zh-CN'][key]).toBe('string');
      expect(I18N.TRANSLATIONS['en-US'][key]).toBeTruthy();
      expect(typeof I18N.TRANSLATIONS['en-US'][key]).toBe('string');
    }
  });

  it('enforces ZERO emojis across all translation strings', () => {
    // Standard emoji regex
    const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

    for (const [lang, dict] of Object.entries<Record<string, string>>(I18N.TRANSLATIONS)) {
      for (const [key, value] of Object.entries(dict)) {
        const hasEmoji = emojiRegex.test(value);
        if (hasEmoji) {
          throw new Error(`Emoji detected in ${lang} key "${key}": "${value}"`);
        }
        expect(hasEmoji).toBe(false);
      }
    }
  });

  it('translates keys accurately and switches languages dynamically', () => {
    I18N.setLanguage('zh-CN');
    expect(I18N.getLanguage()).toBe('zh-CN');
    expect(I18N.t('header.appearance')).toBe('外观');
    expect(I18N.t('rail.newConversation')).toBe('新建会话');

    I18N.setLanguage('en-US');
    expect(I18N.getLanguage()).toBe('en-US');
    expect(I18N.t('header.appearance')).toBe('Appearance');
    expect(I18N.t('rail.newConversation')).toBe('New Conversation');

    // Toggle language
    const toggled = I18N.toggleLanguage();
    expect(toggled).toBe('zh-CN');
    expect(I18N.getLanguage()).toBe('zh-CN');
    expect(I18N.t('header.appearance')).toBe('外观');

    // Fallback handling
    expect(I18N.t('non.existent.key', 'default_fallback')).toBe('default_fallback');
  });

  it('updates mock DOM attributes during applyLanguage', () => {
    // Set up mock DOM elements
    const elements: any[] = [];

    const mockSpan = {
      getAttribute: (attr: string) => (attr === 'data-i18n' ? 'header.appearance' : null),
      textContent: 'old',
      setAttribute: () => {}
    };
    const mockInput = {
      getAttribute: (attr: string) => (attr === 'data-i18n-placeholder' ? 'composer.placeholder' : null),
      setAttribute: (attr: string, val: string) => {
        if (attr === 'placeholder') mockInput.placeholder = val;
      },
      placeholder: ''
    };
    const mockBtn = {
      getAttribute: (attr: string) => (attr === 'data-i18n-title' ? 'header.sidebarToggle' : null),
      setAttribute: (attr: string, val: string) => {
        if (attr === 'title') mockBtn.title = val;
      },
      title: ''
    };

    elements.push(mockSpan, mockInput, mockBtn);

    const originalDoc = (globalThis as any).document;
    (globalThis as any).document = {
      documentElement: { lang: 'zh-CN' },
      querySelectorAll: (selector: string) => {
        if (selector === '[data-i18n]') return [mockSpan];
        if (selector === '[data-i18n-placeholder]') return [mockInput];
        if (selector === '[data-i18n-title]') return [mockBtn];
        if (selector === '.lang-quick-chip') return [];
        return [];
      },
      getElementById: () => null
    };

    try {
      I18N.applyLanguage('en-US');
      expect((globalThis as any).document.documentElement.lang).toBe('en-US');
      expect(mockSpan.textContent).toBe('Appearance');
      expect(mockInput.placeholder).toBe(I18N.TRANSLATIONS['en-US']['composer.placeholder']);
      expect(mockBtn.title).toBe(I18N.TRANSLATIONS['en-US']['header.sidebarToggle']);
    } finally {
      (globalThis as any).document = originalDoc;
    }
  });
});
