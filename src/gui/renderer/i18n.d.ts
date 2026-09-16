export interface I18nEngine {
  TRANSLATIONS: {
    'zh-CN': Record<string, string>;
    'en-US': Record<string, string>;
    [lang: string]: Record<string, string>;
  };
  STORAGE_KEY: string;
  getLanguage(): string;
  setLanguage(lang: string): void;
  toggleLanguage(): string;
  applyLanguage(lang: string): void;
  t(key: string, fallback?: string): string;
  init(): void;
}

declare global {
  interface Window {
    I18N?: I18nEngine;
  }
}

declare const I18N: I18nEngine;
export default I18N;
