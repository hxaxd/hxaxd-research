import '@earendil-works/pi-coding-agent';
import { createRequire } from 'node:module';
const { setGlobalDispatcher, EnvHttpProxyAgent } = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('undici');
setGlobalDispatcher(new EnvHttpProxyAgent());
