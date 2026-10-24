import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile, symlink, cp } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { freePort } from '../free-port.ts';
import { pdfFixture } from '../pdf-fixture.ts';

const root = path.resolve('.runtime/dev/agent-audit', process.argv[2] || randomUUID());
await mkdir(root, { recursive: true });
try { await symlink(path.resolve('.runtime/data/pi'), path.join(root, 'pi'), 'junction'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
await copyFile('.runtime/data/translation.json', path.join(root, 'translation.json'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const app = spawn(process.execPath, ['--use-env-proxy', 'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, APP_DATA_DIR: root, NODE_USE_ENV_PROXY: '1', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(path.resolve('tests/manual/network.mjs')).href}` }, stdio: 'ignore', windowsHide: true,
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/workspaces')).ok) break; } catch {} await sleep(200); }
  const catalog = await (await fetch(base + '/api/models')).json();
  if (!catalog.models?.some(model => model.id === 'openai/gpt-6-luna')) throw new Error('GPT-6 Luna 不可用：'+JSON.stringify(catalog.issues));
  const workspaceId = randomUUID();
  async function post(route, input) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(`${route}: ${response.status}`);
    return response.json();
  }
  await post('/api/workspaces', { id: workspaceId, name: '工作流实测' });
  const workspace = path.join(root, 'workspaces', workspaceId);
  await mkdir(path.join(workspace, 'source'), { recursive: true });
  await writeFile(path.join(workspace, 'source/note.md'), '# Source note\n\nThe identifier is LUNA-42. Energy is $E=mc^2$.\n\nThe measured accuracy is 91 percent.');
  await writeFile(path.join(workspace, 'source/article.html'), '<!doctype html><html><body><h1>A compact study</h1><p>The method combines two signals. Accuracy is 91 percent.</p><figure><svg width="50" height="30"><rect width="50" height="30" fill="blue"/></svg><figcaption>Figure 1: Signal diagram.</figcaption></figure><table><tr><th>Method</th><th>Score</th></tr><tr><td>Ours</td><td>91</td></tr></table><h2>Limitations</h2><p>Only one dataset was evaluated.</p></body></html>');
  await writeFile(path.join(workspace, 'source/main.tex'), String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{A compact study}
The method combines two signals. Accuracy is 91 percent.
\[E=mc^2\]
\section{Limitations}
Only one dataset was evaluated.
\end{document}`);
  await writeFile(path.join(workspace, 'source/broken.tex'), String.raw`\documentclass{article}\begin{document}An equation: $x^2$. \UnknownCommand{result}\end{document}`);
  await writeFile(path.join(workspace, 'source/paper.pdf'), pdfFixture(2));
  const raster = spawnSync(path.resolve('.runtime/env/translation/python/Scripts/python.exe'), ['-c', 'import pymupdf,sys; d=pymupdf.open(sys.argv[1]); d[0].get_pixmap(matrix=pymupdf.Matrix(2,2),clip=pymupdf.Rect(30,50,380,105)).save(sys.argv[2])',path.join(workspace,'source/paper.pdf'),path.join(workspace,'source/chart.png')]);
  if(raster.status !== 0) throw new Error(raster.stderr.toString());
  await mkdir(path.join(workspace, 'repair'), { recursive: true });
  await writeFile(path.join(workspace, 'repair/document.json'), JSON.stringify({ source: '../source/paper.pdf', title: 'Research fixture', pages: [1,2].map(number => ({ number, width:400,height:500, blocks:[{id:`p${number}-b1`,page:number,order:0,label:'text',bbox:[40,60,360,95],text:number===1?'Research fixture: alpha and beta':'Research fixture: page 2',preserve:false}]}))}));
  await writeFile(path.join(workspace, 'repair/translations.json'), JSON.stringify({blocks:[{id:'p1-b1',text:'研究样例：α 与 β'}]}));
  if(process.argv.slice(3).some(name => name.startsWith('real-'))) await cp('.runtime/dev/real-papers-20261023/sources',path.join(workspace,'real'),{recursive:true});
  const all = [
    ['real-tex', '请实际完整翻译 real/bitnet 中的真实论文 TeX 工程，来源版本见 source.json。由你当前助手阅读全文直接翻译成简体中文，不调用额外翻译API；正文、标题、图注、表格及脚注都要覆盖，参考文献保留原文，公式、标签、引用、图片与目录关系保留。不要覆盖原工程，在译稿目录完成。先实际编译原件，再编译完整中文译稿，根据日志修正本次真实错误，在中间阅读区展示新PDF。保留实际日志并如实说明核验范围。'],
    ['real-html', '请完整翻译 real/phi3/source.html 这篇真实论文，官方HTML版本和原始URL见同目录source.json。明确使用这个HTML，由当前助手阅读全文直接翻译成简体中文，不调用额外翻译API。覆盖全部正文、图注、表格和附录，参考文献保留原文；保留数学表达及插图，实际下载需要的相对资源。生成完整Markdown与使用现有论文模板的HTML，运行渲染并在阅读区展示。不要用摘要或概要代替全文；如有失败或未覆盖内容如实报告。'],
    ['real-html-api', '请完整翻译 real/phi3/source.html 这篇真实论文，官方HTML版本和原始URL见同目录source.json。明确使用此HTML，选择调用已注册 openai/gpt-6-luna API 翻译。完整提取论文主体、公式、图注、表格和附录，参考文献及作者保留原文；完整内容交给翻译模型并保留请求和响应，不能截断或只译摘要。保留插图，资源按原网页地址解析。生成完整Markdown与使用现有论文模板的HTML，实际运行渲染并打开阅读区。遇到实际错误按输出修正并继续。'],
    ['real-pdf', '请只使用 real/attention/source.pdf 这份真实论文，走项目独立OCR路线，不寻找其他来源。请使用已注册 openai/gpt-6-luna 调用API完成全文中文块翻译，覆盖全部页；固定流水线生成Markdown、HTML、原版式PDF与双语PDF。要读取实际OCR结果、译块和排版报告，修复真实错误，检查产物并展示双语PDF。不允许仅翻译样例页后声称完成全文。运行资源使用项目现有独立环境。'],
    ['paper-search', '我正在研究多模态检索和图文统一向量表示。请主动联网检索三篇值得读的相关论文，核对官方来源的题名、作者、年份、链接，并说明各自与这个研究方向的关系。不要仅凭记忆罗列；选一篇可公开获取的论文，把 PDF 下载到当前工作区，实际读取核对内容，然后在中间阅读区打开给我看。本轮不翻译，也不调用额外模型。'],
    ['clarify', '请把 source/note.md 翻译成中文。'],
    ['clarify-conditional', '请把 source/note.md 翻译成中文。如果后续需要额外模型调用，可用范围仅为 openai/gpt-6-luna。'],
    ['reference', '我当前看的文件和引用来源不同。请解释引用段落中的准确率和局限，不要把当前打开的另一份材料当作选段来源。不需要翻译全文。'],
    ['image-reference', '所附图片中可见的完整文字是什么？请按图片内容读取，不要依据文件名猜测，不需要生成文档。'],
    ['source-choice', '示例论文有 source/main.tex、source/article.html、source/paper.pdf 三个来源。请按合适的来源路线处理，由你本人完整翻译成中文，保留公式，原件不覆盖，实际编译或渲染，并在中间阅读区展示。'],
    ['external-link', '请在中间阅读区打开 http://localhost:3000/ ，我想知道现在能不能直接展示。若不支持，就给我能在外层浏览器点开的链接，不要启动服务。'],
    ['files', '请检查当前工作区名称和论文目录信息，然后用原生文件工具在 analysis/note.md 写一份简短笔记，写完读取核对。最后把它在中间阅读区预览出来。'],
    ['pdf', '当前打开的是 source/paper.pdf 的第2页。请实际读取这一页，告诉我这一页写了什么，再打开第1页让我看。不要猜测文件内容。'],
    ['markdown', '请读取 source/note.md，生成 output/note.md，保留内容并加入一个两列表格及公式 x_i^2，打开 Markdown 预览，然后再切换到源码让我看。'],
    ['html', '请在 output/panel/index.html 创建一个本地交互页：有递增计数按钮，使用相对路径 app.js。执行脚本，打开预览。再解释当前 HTML 能访问什么、不能直接做什么。如果要打开 http://localhost:3000/ 应如何让我点开？不要启动服务。'],
    ['tex-repair', '请编译 source/broken.tex。它有一个实际排版错误，请根据编译日志修好，再编译并在阅读区展示新PDF。不要把旧文件当成功结果。'],
    ['tex-translation', '请把 source/main.tex 这个完整小工程翻译成中文。由你自己直接阅读全文翻译，保留公式和结构，原件不覆盖，实际编译中文译稿并打开PDF。'],
    ['html-translation', '请把 source/article.html 的所有内容（包括图注、表格和局限）翻译成中文，由你本人直接完整翻译。明确使用这个 HTML，不需要去找其他来源。保留插图，制作适合阅读的独立HTML并打开。'],
    ['ocr-direct', '请使用项目独立 OCR 解析 source/paper.pdf，再由你自己完整翻译成中文，不调用翻译API。产出 Markdown 和 HTML，使用现有论文模板并实际打开HTML；没有要求保留PDF版式。'],
    ['ocr-api-layout', '请使用 OCR 解析 source/paper.pdf，使用已注册模型 openai/gpt-6-luna 将全文块翻译成中文，保留原PDF版式，并生成双语PDF。使用固定流水线，检查排版报告并打开结果。'],
    ['render-repair', 'repair/document.json 是已完成OCR的规范化全文，repair/translations.json 是缺少译块的响应。由你本人读取完整原文，先实际尝试渲染，根据错误补齐中文译文，再渲染并打开 HTML。不要重复OCR或调用额外翻译API。'],
    ['native-command', '请通过原生命令运行一个小脚本，计算1到10之和，将结果写入 output/sum.txt，再读取核验，最后在中间阅读区打开这个结果文件。'],
  ];
  const selected = process.argv.slice(3);
  const cases = selected.length ? all.filter(([name]) => selected.includes(name)) : all;
  const results = [];
  for (const [name, prompt] of cases) {
    const model = name === 'paper-search' ? 'openai/gpt-6.1-sol' : 'openai/gpt-6-luna';
    const id = randomUUID();
    await post(`/api/workspaces/${workspaceId}/conversations`, { id, name });
    await post(`/api/workspaces/${workspaceId}/conversations/${id}/messages`, {
      id: randomUUID(), model, text: prompt+(name === 'clarify-conditional' ? '' : `\n本轮所有模型调用仅使用 ${model}。`),
      reading: name === 'pdf' ? { path: 'source/paper.pdf', page: 2 } : name === 'reference' ? {path:'source/note.md',mode:'preview'} : null,
      ...(name === 'reference' ? {quotes:[{path:'source/article.html',mode:'preview',text:'The method combines two signals. Accuracy is 91 percent. Only one dataset was evaluated.'}]} : {}),
      ...(name === 'image-reference' ? {clips:[{path:'source/chart.png',data:(await readFile(path.join(workspace,'source/chart.png'))).toString('base64')}]} : {}),
    });
    const started = Date.now();
    let snapshot;
    do {
      await sleep(1500);
      snapshot = await (await fetch(`${base}/api/workspaces/${workspaceId}/conversations/${id}`)).json();
      if (Date.now() - started > 900000) { await post(`/api/workspaces/${workspaceId}/conversations/${id}/stop`, { id: snapshot.run.id }); break; }
    } while (['accepted','running'].includes(snapshot.run?.status));
    const log = (await readFile(path.join(workspace, '.pi/sessions', `${id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const tools = log.filter(entry => entry.type === 'message' && entry.message.role === 'assistant').flatMap(entry => entry.message.content.filter(part => part.type === 'toolCall').map(part => ({ tool: part.name, args: part.arguments })));
    const answer = snapshot.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n');
    const result = { name, conversationId: id, seconds: Math.round((Date.now()-started)/1000), status: snapshot.run?.status, error: snapshot.error, tools, answer,
      models: [...new Set(log.filter(entry => entry.type==='message' && entry.message.role==='assistant').map(entry=>entry.message.model))] };
    results.push(result);
    await writeFile(path.join(root, 'results.json'), JSON.stringify({ root, workspaceId, results }, null, 2));
    console.log(JSON.stringify({ name, status: result.status, seconds: result.seconds, tools: tools.map(call => call.tool), answer: answer.slice(0,1800) }));
  }
  console.log(JSON.stringify({ root, workspaceId, finished: results.length }));
} finally { app.kill(); }
