import "server-only";

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { AppConfig } from "@/server/config.mjs";
import { ApiError } from "@/shared/http/api-error";

import type { Authorization, ModelCatalog, ProviderSettings } from "../schema";
import { chatgptLogin } from "./chatgpt-login";
import { createModelRuntime, modelCatalog, resolveModel, ModelAccessError, thinkingLevels } from '../runtime.mjs';
import { SpeechConnections } from './speech-connections';
import type { SpeechConnectionInput, SpeechSettings } from '../schema';
import { listModelConnections } from './connections';

type Login = {
  snapshot: Authorization;
  controller: AbortController;
  done: Promise<void>;
  submit?: (url: string) => void;
};

export class ModelProviders {
  private runtime?: Promise<ModelRuntime>;
  private login?: Login;

  private readonly speech: SpeechConnections;

  constructor(private readonly config: AppConfig) { this.speech = new SpeechConnections(config); }

  async speechSettings(): Promise<SpeechSettings> {
    const stored = this.speech.readSettings();
    return { activeId: stored.activeId, connections: stored.connections,
      chatgpt: { connected: await this.speechAuthorization(), model: stored.chatgptModel } };
  }

  async speechTarget(connectionId: string, signal?: AbortSignal) {
    const target = this.speech.resolve(connectionId);
    return target.kind === 'chatgpt' ? { ...target, token: await this.speechAccessToken(signal) } : target;
  }

  async selectSpeech(id: string | null) { this.speech.select(id); return this.speechSettings(); }
  async createSpeech(input: SpeechConnectionInput) { this.speech.create(input); return this.speechSettings(); }
  async updateSpeech(id: string, input: SpeechConnectionInput) { this.speech.update(id, input); return this.speechSettings(); }
  async removeSpeech(id: string) { this.speech.remove(id); return this.speechSettings(); }
  async setChatgptModel(model: string) { this.speech.setChatgptModel(model); return this.speechSettings(); }

  getRuntime() {
    this.runtime ??= createModelRuntime(this.config.piDir).then((runtime) => {
      const openai = runtime.getProvider("openai")!;
      const oauth = openai.auth.oauth!;
      runtime.registerNativeProvider({
        ...openai,
        auth: {
          ...openai.auth,
          oauth: {
            ...oauth,
            login: chatgptLogin(path.join(this.config.piDir, "auth.json")),
          },
        },
      });
      return runtime;
    });
    return this.runtime;
  }

  async resolve(id: string, signal?: AbortSignal) {
    const runtime = await this.getRuntime();
    try { return { runtime, model: await resolveModel(runtime, id, signal, this.config.timeouts.modelCatalogMs) }; }
    catch (error) {
      if (error instanceof ModelAccessError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  }

  async list(): Promise<ModelCatalog> {
    const catalog = await modelCatalog(await this.getRuntime(), undefined, this.config.timeouts.modelCatalogMs);
    return { ...catalog, models: catalog.models.map(model => ({
      id: `${model.provider}/${model.id}`, name: model.name, provider: model.provider,
      input: model.input, thinkingLevels: thinkingLevels(model) as ModelCatalog['models'][number]['thinkingLevels'],
    })) };
  }

  async speechAuthorization() {
    const runtime = await this.getRuntime();
    return runtime.isUsingSubscription("openai");
  }

  async speechAccessToken(signal?: AbortSignal) {
    const runtime = await this.getRuntime();
    if (!runtime.isUsingSubscription("openai"))
      throw new ApiError(
        409,
        "chatgpt_not_connected",
        "请先在模型设置中连接 ChatGPT 授权",
      );
    const auth = await runtime.getAuth("openai", { signal });
    if (!auth?.auth.apiKey)
      throw new ApiError(
        409,
        "chatgpt_not_connected",
        "ChatGPT 授权不可用，请重新连接",
      );
    return auth.auth.apiKey;
  }

  async settings(): Promise<ProviderSettings> {
    const runtime = await this.getRuntime();
    const credentials = await runtime.listCredentials();
    return {
      connections: listModelConnections(this.config, runtime),
      providers: runtime
        .getProviders()
        .filter(
          (provider) =>
            provider.id === "openai" || runtime.hasConfiguredAuth(provider.id),
        )
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          connected: runtime.hasConfiguredAuth(provider.id),
          subscription: runtime.isUsingSubscription(provider.id),
          canDisconnect: credentials.some(
            (credential) =>
              credential.providerId === provider.id &&
              credential.type === "oauth",
          ),
        })),
      authorization: this.login?.snapshot ?? null,
    };
  }

  private active() {
    return (
      this.login &&
      ["starting", "waiting", "exchanging"].includes(this.login.snapshot.status)
    );
  }

  private deviceId() {
    const file = path.join(this.config.piDir, "device-id.json");
    if (existsSync(file))
      return z.uuid().parse(JSON.parse(readFileSync(file, "utf8")));
    const id = randomUUID();
    writeFileSync(file, JSON.stringify(id), { mode: 0o600 });
    return id;
  }

  async connect(id: string) {
    const runtime = await this.getRuntime();
    if (this.login?.snapshot.id === id) return this.login.snapshot;
    if (this.active())
      throw new ApiError(
        409,
        "authorization_busy",
        "已有 ChatGPT 授权正在进行",
      );
    const deviceId = this.deviceId();
    // Reserve the attempt before starting the SDK's callback listener.
    const login: Login = {
      snapshot: {
        id,
        status: "starting",
        url: null,
        manualInput: false,
        error: null,
      },
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.login = login;
    login.done = runtime
      .login(
        "openai",
        "oauth",
        {
          signal: login.controller.signal,
          notify(event) {
            if (event.type === "auth_url") {
              login.snapshot = {
                ...login.snapshot,
                status: "waiting",
                url: event.url,
              };
            } else if (event.type === "progress") {
              login.snapshot = {
                ...login.snapshot,
                status: "exchanging",
                manualInput: false,
              };
            }
          },
          prompt(prompt) {
            return new Promise<string>((resolve, reject) => {
              const signal = prompt.signal ?? login.controller.signal;
              const abort = () => {
                login.submit = undefined;
                reject(signal.reason);
              };
              if (signal.aborted) return abort();
              signal.addEventListener("abort", abort, { once: true });
              login.snapshot = { ...login.snapshot, manualInput: true };
              login.submit = (url) => {
                signal.removeEventListener("abort", abort);
                login.submit = undefined;
                login.snapshot = { ...login.snapshot, manualInput: false };
                resolve(url);
              };
            });
          },
        },
        { getDeviceId: () => deviceId },
      )
      .then(() => {
        login.snapshot = {
          ...login.snapshot,
          status: "connected",
          url: null,
          manualInput: false,
        };
      })
      .catch((error: unknown) => {
        login.snapshot = {
          ...login.snapshot,
          status: login.controller.signal.aborted ? "cancelled" : "failed",
          url: null,
          manualInput: false,
          error: login.controller.signal.aborted
            ? null
            : error instanceof Error
              ? error.message
              : "ChatGPT 连接失败",
        };
      });
    return login.snapshot;
  }

  async cancel(id: string) {
    if (this.login?.snapshot.id !== id)
      throw new ApiError(
        409,
        "authorization_changed",
        "授权已更新，请刷新供应商设置",
      );
    if (this.active()) this.login.controller.abort();
    await this.login.done;
    return this.login.snapshot;
  }

  submit(id: string, url: string) {
    if (this.login?.snapshot.id !== id || !this.login.submit)
      throw new ApiError(
        409,
        "authorization_not_waiting",
        "当前没有等待回调地址的授权",
      );
    this.login.submit(url);
    return this.login.snapshot;
  }

  async disconnect() {
    if (this.active()) await this.cancel(this.login!.snapshot.id);
    const runtime = await this.getRuntime();
    await runtime.logout("openai");
    this.login = undefined;
    return this.settings();
  }
}
