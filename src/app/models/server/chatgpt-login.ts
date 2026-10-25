import { text as t } from '@/app/i18n/server.mjs';
import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  readStoredCredential,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

type OAuth = NonNullable<
  NonNullable<ReturnType<ModelRuntime["getProvider"]>>["auth"]["oauth"]
>;

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const directScope = "chatgpt.tokens.use.direct";
const scopes = `openid profile email offline_access resource.invoke ${directScope}`;
const keys = createRemoteJWKSet(new URL("/.well-known/jwks.json", issuer));
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string(),
});

export function chatgptLogin(authPath: string): OAuth["login"] {
  return async (interaction, options) => {
    interaction.signal.throwIfAborted();
    const stored = readStoredCredential("openai", authPath);
    const previous = stored?.type === "oauth" ? stored : undefined;
    const clientId =
      typeof previous?.clientId === "string" ? previous.clientId : undefined;
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const callback = Promise.withResolvers<{
      code: string;
      clientId: string;
    }>();
    const manual = new AbortController();
    let redirectUri: string;

    function parseCallback(url: URL) {
      const expected = new URL(redirectUri);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname)
        throw new Error(t('errors.callbackRequired'));
      if (url.searchParams.get("state") !== state)
        throw new Error(t('errors.callbackAttempt'));
      const error = url.searchParams.get("error");
      if (error) throw new Error(t('errors.authorizationDetail', {value0: error}));
      const code = url.searchParams.get("code");
      const issuedId = url.searchParams.get("client_id") ?? clientId;
      if (!code || !issuedId || issuedId === "dynamic_agent_client")
        throw new Error(t('errors.callbackFields'));
      if (clientId && issuedId !== clientId)
        throw new Error(t('errors.callbackClient'));
      return { code, clientId: issuedId };
    }

    const server = createServer((request, response) => {
      const url = new URL(request.url!, redirectUri);
      if (request.method !== "GET" || url.pathname !== "/auth/callback") {
        response.writeHead(404).end();
        return;
      }
      try {
        const result = parseCallback(url);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>ChatGPT</title><h1>${t('models.callbackReceived')}</h1><p>${t('models.callbackReturn')}</p>`,
        );
        callback.resolve(result);
      } catch {
        response.writeHead(400, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(t('errors.callbackInvalid'));
        if (
          url.searchParams.get("state") === state &&
          url.searchParams.has("error")
        )
          callback.reject(
            new Error(t('errors.authorizationDetail', {value0: url.searchParams.get("error")})),
          );
      }
    });

    try {
      const listening = once(server, "listening", {
        signal: interaction.signal,
      });
      server.listen(0, "127.0.0.1");
      await listening;
      server.on("error", callback.reject);
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`;
      const authorizationUrl = new URL("/api/accounts/authorize", issuer);
      authorizationUrl.search = new URLSearchParams({
        client_id: clientId ?? "dynamic_agent_client",
        ext_agent_host_id: `urn:uuid:${options!.getDeviceId!()}`,
        response_type: "code",
        redirect_uri: redirectUri,
        resource,
        scope: scopes,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      }).toString();
      if (!clientId)
        authorizationUrl.searchParams.set("agent_name_hint", "hxaxd Research");
      if (typeof previous?.idToken === "string")
        authorizationUrl.searchParams.set("id_token_hint", previous.idToken);
      interaction.notify({
        type: "auth_url",
        url: authorizationUrl.toString(),
      });
      const fromManual = interaction
        .prompt({
          type: "manual_code",
          message: t('models.authorizationPending'),
          placeholder: redirectUri,
          signal: AbortSignal.any([manual.signal, interaction.signal]),
        })
        .then((input) => parseCallback(new URL(input.trim())));
      const result = await Promise.race([callback.promise, fromManual]);
      manual.abort();
      interaction.notify({
        type: "progress",
        message: t('models.authorizing'),
      });
      const response = await fetch(
        new URL("/api/accounts/oauth/token", issuer),
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: result.clientId,
            code: result.code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource,
          }),
          signal: interaction.signal,
        },
      );
      if (!response.ok)
        throw new Error(
          t('errors.tokenExchange', {value0: response.status}),
        );
      const token = tokenSchema.parse(await response.json());
      const { payload } = await jwtVerify(token.id_token, keys, {
        issuer,
        audience: result.clientId,
        requiredClaims: ["exp", "sub", "nonce"],
      });
      if (payload.nonce !== nonce)
        throw new Error(t('errors.identityToken'));
      if (previous?.subject && previous.subject !== payload.sub)
        throw new Error(t('errors.accountMismatch'));
      const grantedScopes = token.scope.split(/\s+/);
      if (!grantedScopes.includes(directScope))
        throw new Error(t('errors.authorizationScope'));
      return {
        type: "oauth",
        access: token.access_token,
        refresh: token.refresh_token,
        expires: Date.now() + token.expires_in * 1000 - 180000,
        clientId: result.clientId,
        scopes: grantedScopes,
        idToken: token.id_token,
        subject: payload.sub,
      };
    } finally {
      manual.abort();
      server.close();
      server.closeAllConnections();
    }
  };
}
