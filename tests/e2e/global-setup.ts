import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startModelServer } from '../model-server';
export default async function setup() {
  const model = await startModelServer();
  const directory = path.join(process.env.RESEARCH_E2E_DATA!, 'pi'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'models.json'), JSON.stringify(model.config));
  return () => model.close();
}
