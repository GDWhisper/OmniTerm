import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import zh from './locales/zh/translation.json'
import en from './locales/en/translation.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      zh: { translation: zh },
      en: { translation: en },
    },
    fallbackLng: 'en',
    // 探测范围白名单（performance-remaining-tiers.md 3.1 方案 B）：项目只有
    // 2 个 locale，detector 不必对 navigator 全量语言列表做资源匹配；
    // nonExplicitSupportedLngs 把 zh-CN / en-US 归一化到 zh / en。
    supportedLngs: ['en', 'zh'],
    nonExplicitSupportedLngs: true,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'omniterm_locale',
      caches: ['localStorage'],
    },
    interpolation: {
      escapeValue: false,
    },
  })

export default i18n
