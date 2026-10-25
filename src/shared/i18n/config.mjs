import { createTranslator } from 'use-intl/core';
import zhCN from './messages/zh-CN.json' with { type: 'json' };
import en from './messages/en.json' with { type: 'json' };

const locales = ['zh-CN', 'en'];
const defaultLocale = 'zh-CN';
export const localeCookie = 'research-locale';
export const messages = { 'zh-CN': zhCN, en };

export function resolveLocale(value) {
  return locales.includes(value) ? value : defaultLocale;
}

export function translator(locale = defaultLocale) {
  return createTranslator({ locale, messages: messages[locale] });
}
