import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** @param {import('./config.mjs').AppConfig['network']} network */
export function configureNetwork(network) {
  setGlobalDispatcher(new EnvHttpProxyAgent({
    httpProxy: network.proxy ?? undefined,
    httpsProxy: network.proxy ?? undefined,
    noProxy: [process.env.no_proxy ?? process.env.NO_PROXY, network.noProxy].filter(Boolean).join(','),
  }));
}
