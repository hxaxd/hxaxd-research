import 'server-only';
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { createWorkspaceSchema, workspaceSchema, renameSchema, idSchema } from '@/features/workspaces/workspace-schema';
import { createPaperSchema, paperSchema } from '@/features/papers/paper-schema';
import { fileEntrySchema, importResultSchema, textFileSchema } from '@/features/files/file-schema';
import { createConversationSchema, conversationSchema, sendMessageSchema, runSchema, conversationSnapshotSchema, conversationEventSchema, modelSchema } from '@/features/conversations/conversation-schema';
extendZodWithOpenApi(z);
export function generateOpenapi() {
  const registry = new OpenAPIRegistry();
  const prefix = '/api/workspaces/{workspaceId}';
  const conversation = `${prefix}/conversations/{conversationId}`;
  const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }) });
  const routes: { method: 'get' | 'post' | 'patch'; path: string; response: z.ZodType; body?: z.ZodType; status?: number }[] = [
    { method: 'get', path: '/api/workspaces', response: z.array(workspaceSchema) },
    { method: 'post', path: '/api/workspaces', response: workspaceSchema, body: createWorkspaceSchema, status: 201 },
    { method: 'patch', path: prefix, response: workspaceSchema, body: renameSchema },
    { method: 'get', path: `${prefix}/papers`, response: z.array(paperSchema) },
    { method: 'post', path: `${prefix}/papers`, response: paperSchema, body: createPaperSchema, status: 201 },
    { method: 'patch', path: `${prefix}/papers/{paperId}`, response: paperSchema, body: renameSchema },
    { method: 'get', path: `${prefix}/files`, response: z.array(fileEntrySchema) },
    { method: 'get', path: `${prefix}/conversations`, response: z.array(conversationSchema) },
    { method: 'post', path: `${prefix}/conversations`, response: conversationSchema, body: createConversationSchema, status: 201 },
    { method: 'get', path: conversation, response: conversationSnapshotSchema },
    { method: 'patch', path: conversation, response: conversationSchema, body: renameSchema },
    { method: 'post', path: `${conversation}/messages`, response: runSchema, body: sendMessageSchema, status: 202 },
    { method: 'post', path: `${conversation}/stop`, response: runSchema.nullable(), body: z.object({ id: idSchema }) },
    { method: 'get', path: '/api/models', response: z.array(modelSchema) },
  ];
  for (const route of routes) {
    const params = Object.fromEntries(Array.from(route.path.matchAll(/\{(\w+)\}/g), match => [match[1], idSchema]));
    registry.registerPath({ method: route.method, path: route.path, request: { params: z.object(params), ...(route.path.endsWith('/files') ? { query: z.object({ path: z.string().optional() }) } : {}), ...(route.body ? { body: { content: { 'application/json': { schema: route.body } } } } : {}) }, responses: { [route.status ?? 200]: { description: 'Success', content: { 'application/json': { schema: route.response } } }, default: { description: 'Error', content: { 'application/json': { schema: errorSchema } } } } });
  }
  const params = z.object({ workspaceId: idSchema });
  registry.registerPath({ method: 'get', path: `${prefix}/file`, request: { params, query: z.object({ path: z.string(), format: z.literal('text').optional(), download: z.string().optional() }) }, responses: { 200: { description: 'File or text preview', content: { 'application/octet-stream': { schema: z.string() }, 'application/json': { schema: textFileSchema } } }, 206: { description: 'Byte range' }, 416: { description: 'Invalid byte range' } } });
  registry.registerPath({ method: 'post', path: `${prefix}/imports`, request: { params, body: { content: { 'multipart/form-data': { schema: z.object({ metadata: z.string().describe('JSON: requestId, target, optional folderName; precedes files'), files: z.array(z.string().openapi({ format: 'binary' })) }) } } } }, responses: { 201: { description: 'Import result', content: { 'application/json': { schema: importResultSchema } } } } });
  registry.register('ConversationEvent', conversationEventSchema.clone());
  registry.registerPath({ method: 'get', path: `${conversation}/events`, request: { params: z.object({ workspaceId: idSchema, conversationId: idSchema }) }, responses: { 200: { description: 'SSE data frames contain ConversationEvent', content: { 'text/event-stream': { schema: z.string() } } } } });
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: '3.1.0', info: { title: 'Research Workbench', version: '1.0.0' } });
}
