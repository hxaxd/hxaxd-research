import { AsyncLocalStorage } from 'node:async_hooks';
import { localeCookie, resolveLocale, translator } from '../../shared/i18n/config.mjs';

const language = new AsyncLocalStorage();
const defaultText = translator();

export function requestLocale(request) {
  const cookies = request.headers.get('cookie')?.split(';').map(part => part.trim()) ?? [];
  const value = cookies.find(part => part.startsWith(`${localeCookie}=`))?.slice(localeCookie.length + 1);
  return resolveLocale(value);
}

export function withLocale(locale, operation) {
  return language.run(translator(locale), operation);
}

export function text(key, values) {
  return (language.getStore() ?? defaultText)(key, values);
}
