import 'server-only';

import {
  extendZodWithOpenApi,
  OpenApiGeneratorV31,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  conversationEventSchema,
  conversationImageQuerySchema,
  conversationSchema,
  conversationSnapshotSchema,
  createConversationSchema,
  runSchema,
  sendMessageSchema,
  stopRunSchema,
} from '@/app/conversations/schema';
import {
  fileEntrySchema,
  createDirectorySchema,
  directoryResultSchema,
  importResultSchema,
  textFileSchema,
  readerRequestSchema,
} from '@/app/files/schema';
import {
  authorizationCallbackSchema,
  authorizationRequestSchema,
  authorizationSchema,
  modelCatalogSchema,
  providerSettingsSchema,
  modelConnectionInputSchema,
  modelDiscoverySchema,
  modelDiscoveryResultSchema,
  modelConnectionIdSchema,
  speechChatgptSchema,
  speechConnectionInputSchema,
  speechSelectionSchema,
  speechSettingsSchema,
  speechConnectionRefSchema,
} from '@/app/models/schema';
import {
  speechRealtimeResultSchema,
  speechRealtimeSchema,
  speechTestResultSchema,
  speechTranscriptSchema,
} from '@/app/speech/schema';
import {
  createWorkspaceSchema,
  workspaceSchema,
} from '@/app/workspaces/schema';
import { apiErrorSchema } from '@/shared/http/api-error';
import { idSchema, renameSchema } from '@/shared/schema';

extendZodWithOpenApi(z);

export function generateOpenapi() {
  const registry = new OpenAPIRegistry();
  const prefix = '/api/workspaces/{workspaceId}';
  const conversation = `${prefix}/conversations/{conversationId}`;
  const routes: {
    method: 'get' | 'post' | 'patch' | 'delete';
    path: string;
    response: z.ZodType;
    body?: z.ZodType;
    status?: number;
  }[] = [
    { method: 'post', path: '/api/model-providers/connections', body: modelConnectionInputSchema, response: providerSettingsSchema },
    { method: 'patch', path: '/api/model-providers/connections/{id}', body: modelConnectionInputSchema, response: providerSettingsSchema },
    { method: 'delete', path: '/api/model-providers/connections/{id}', response: providerSettingsSchema },
    { method: 'post', path: '/api/model-providers/discover', body: modelDiscoverySchema, response: modelDiscoveryResultSchema },
    {
      method: 'get',
      path: '/api/workspaces',
      response: z.array(workspaceSchema),
    },
    {
      method: 'post',
      path: '/api/workspaces',
      response: workspaceSchema,
      body: createWorkspaceSchema,
      status: 201,
    },
    {
      method: 'patch',
      path: prefix,
      response: workspaceSchema,
      body: renameSchema,
    },
    { method: 'get', path: prefix, response: workspaceSchema },
    { method: 'post', path: `${prefix}/files`, body: createDirectorySchema, response: directoryResultSchema, status: 201 },
    {
      method: 'get',
      path: `${prefix}/files`,
      response: z.array(fileEntrySchema),
    },
    {
      method: 'get',
      path: `${prefix}/conversations`,
      response: z.array(conversationSchema),
    },
    {
      method: 'post',
      path: `${prefix}/conversations`,
      response: conversationSchema,
      body: createConversationSchema,
      status: 201,
    },
    { method: 'get', path: conversation, response: conversationSnapshotSchema },
    {
      method: 'patch',
      path: conversation,
      response: conversationSchema,
      body: renameSchema,
    },
    {
      method: 'post',
      path: `${conversation}/messages`,
      response: runSchema,
      body: sendMessageSchema,
      status: 202,
    },
    {
      method: 'post',
      path: `${conversation}/stop`,
      response: runSchema.nullable(),
      body: stopRunSchema,
    },
    { method: 'get', path: '/api/models', response: modelCatalogSchema },
    {
      method: 'get',
      path: '/api/model-providers',
      response: providerSettingsSchema,
    },
    {
      method: 'delete',
      path: '/api/model-providers/openai',
      response: providerSettingsSchema,
    },
    {
      method: 'post',
      path: '/api/model-providers/openai/authorization',
      body: authorizationRequestSchema,
      response: authorizationSchema,
    },
    {
      method: 'delete',
      path: '/api/model-providers/openai/authorization',
      body: authorizationRequestSchema,
      response: authorizationSchema,
    },
    {
      method: 'post',
      path: '/api/model-providers/openai/authorization/callback',
      body: authorizationCallbackSchema,
      response: authorizationSchema,
    },
    {
      method: 'get',
      path: '/api/speech',
      response: speechSettingsSchema,
    },
    {
      method: 'patch',
      path: '/api/speech',
      body: speechSelectionSchema,
      response: speechSettingsSchema,
    },
    {
      method: 'post',
      path: '/api/speech/connections',
      body: speechConnectionInputSchema,
      response: speechSettingsSchema,
    },
    {
      method: 'patch',
      path: '/api/speech/connections/{id}',
      body: speechConnectionInputSchema,
      response: speechSettingsSchema,
    },
    {
      method: 'delete',
      path: '/api/speech/connections/{id}',
      response: speechSettingsSchema,
    },
    {
      method: 'patch',
      path: '/api/speech/chatgpt',
      body: speechChatgptSchema,
      response: speechSettingsSchema,
    },
    {
      method: 'post',
      path: '/api/speech/test',
      body: speechConnectionRefSchema,
      response: speechTestResultSchema,
    },
    {
      method: 'post',
      path: '/api/speech/realtime',
      body: speechRealtimeSchema,
      response: speechRealtimeResultSchema,
    },
  ];
  for (const route of routes) {
    const params = Object.fromEntries(
      Array.from(route.path.matchAll(/\{(\w+)\}/g), (match) => [
        match[1],
        route.path.startsWith('/api/model-providers/connections/') ? modelConnectionIdSchema : idSchema,
      ]),
    );
    registry.registerPath({
      method: route.method,
      path: route.path,
      request: {
        params: z.object(params),
        ...(route.path.endsWith('/files')
          ? { query: z.object({ path: z.string().optional() }) }
          : {}),
        ...(route.body
          ? {
              body: { content: { 'application/json': { schema: route.body } } },
            }
          : {}),
      },
      responses: {
        [route.status ?? 200]: {
          description: 'Success',
          content: { 'application/json': { schema: route.response } },
        },
        default: {
          description: 'Error',
          content: { 'application/json': { schema: apiErrorSchema } },
        },
      },
    });
  }
  const params = z.object({ workspaceId: idSchema });
  registry.registerPath({
    method: 'get',
    path: `${conversation}/images`,
    request: { params: params.extend({ conversationId: idSchema }), query: conversationImageQuerySchema },
    responses: {
      200: { description: 'Image from the Pi conversation history', content: { 'image/png': { schema: z.string().openapi({ format: 'binary' }) } } },
      404: { description: 'Image not found', content: { 'application/json': { schema: apiErrorSchema } } },
    },
  });
  registry.register('ReaderRequest', readerRequestSchema.clone());
  registry.registerPath({
    method: 'post',
    path: '/api/speech/transcriptions',
    request: {
      body: {
        content: {
          'multipart/form-data': {
            schema: z.object({
              connectionId: z.string(),
              audio: z.string().openapi({ format: 'binary' }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Transcribed text',
        content: { 'application/json': { schema: speechTranscriptSchema } },
      },
      default: {
        description: 'Error',
        content: { 'application/json': { schema: apiErrorSchema } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: `${prefix}/preview/{path}`,
    request: { params: params.extend({ path: z.string().describe('Workspace relative file path; may contain slashes') }) },
    responses: {
      200: { description: 'Document or relative preview asset', content: { 'application/octet-stream': { schema: z.string() } } },
      206: { description: 'Byte range' },
      416: { description: 'Invalid byte range' },
    },
  });
  registry.registerPath({
    method: 'get',
    path: `${prefix}/file`,
    request: {
      params,
      query: z.object({
        path: z.string(),
        format: z.literal('text').optional(),
        download: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'File or text preview',
        content: {
          'application/octet-stream': { schema: z.string() },
          'application/json': { schema: textFileSchema },
        },
      },
      206: { description: 'Byte range' },
      416: { description: 'Invalid byte range' },
    },
  });
  registry.registerPath({
    method: 'post',
    path: `${prefix}/imports`,
    request: {
      params,
      body: {
        content: {
          'multipart/form-data': {
            schema: z.object({
              metadata: z
                .string()
                .describe('JSON: target, optional folderName; precedes files'),
              files: z.array(z.string().openapi({ format: 'binary' })),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Import result',
        content: { 'application/json': { schema: importResultSchema } },
      },
    },
  });
  registry.register('ConversationEvent', conversationEventSchema.clone());
  registry.registerPath({
    method: 'get',
    path: `${prefix}/files/events`,
    request: { params },
    responses: {
      200: {
        description: 'SSE data: changed relative paths; named reader events contain ReaderRequest',
        content: { 'text/event-stream': { schema: z.string() } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: `${conversation}/events`,
    request: {
      params: z.object({ workspaceId: idSchema, conversationId: idSchema }),
    },
    responses: {
      200: {
        description: 'SSE data frames contain ConversationEvent',
        content: { 'text/event-stream': { schema: z.string() } },
      },
    },
  });
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Research Workbench', version: '1.0.0' },
  });
}
