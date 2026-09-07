import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCitationGraph } from '../scripts/citation-graph.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('counts distinct IDs with duplicate titles, overlapping evidence and self citations', () => {
  const graph=buildCitationGraph([
    {paperId:'a',title:'Same title',references:[{paperId:'c'},{paperId:'c'},{paperId:'a'}]},
    {paperId:'b',title:'Same title',references:[{paperId:'c'}]},
    {paperId:'c',title:'Target',citations:[{paperId:'a'},{paperId:'outside'}]},
  ]);
  assert.equal(graph.nodes.find(n=>n.id==='c').citationCount,2);
  assert.equal(graph.edges.length,2);
  assert.deepEqual([...graph.incoming.get('c')],['a','b']);
});

test('adding and removing indexed nodes changes edges without counting outside papers',()=>{
 const a={paperId:'a',title:'A',references:[{paperId:'b'}]};
 assert.equal(buildCitationGraph([a]).edges.length,0);
 assert.equal(buildCitationGraph([a,{paperId:'b',title:'B'}]).nodes.find(n=>n.id==='b').citationCount,1);
});

test('incremental update requests only new paper and paginates incoming citations; offline rebuild agrees',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'citation-graph-test-'));
 try {
  await fs.mkdir(path.join(root,'references'));
  const old={paperId:'old',title:'Old paper',publicationDate:'2020-01-01',references:[]};
  await fs.writeFile(path.join(root,'references/citation-cache.json'),JSON.stringify({schemaVersion:1,lookups:{'id:old':'old'},papers:{old}}));
  await fs.writeFile(path.join(root,'references/internal-citations.json'),JSON.stringify({entries:[{title:'Old paper',semanticScholarPaperId:'old'}]}));
  await fs.writeFile(path.join(root,'references/citations.bib'),'@article{old,\n}\n@article{new,\n}\n');
  await fs.writeFile(path.join(root,'README.md'),'- updated incrementally\n<summary>X-to-3D</summary>\n\n- [Old paper](https://arxiv.org/abs/2001.00001) | [citation](./references/citations.bib#L1-L2)\n\n- [New paper](https://arxiv.org/abs/2609.99999) | [citation](./references/citations.bib#L3-L4)\n');
  const mock=path.join(root,'mock.mjs');
  await fs.writeFile(mock,`import assert from 'node:assert/strict';
  globalThis.fetch=async(url,options)=>{
   if(url.includes('/batch?')){assert.deepEqual(JSON.parse(options.body).ids,['ARXIV:2609.99999']);return {ok:true,json:async()=>[{paperId:'new',title:'New paper',publicationDate:'2026-09-07',references:[{paperId:'old'}]}]};}
   assert(url.includes('/paper/new/citations?'));
   return {ok:true,json:async()=>url.endsWith('offset=0')?{data:[{citingPaper:{paperId:'old'}}],next:1000}:{data:[{citingPaper:{paperId:'outside'}}]}};
  };`);
  const script=path.resolve('scripts/update-index-metadata.mjs');
  const run=args=>{const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
  run(['--import',mock,script]);
  const graph=JSON.parse(await fs.readFile(path.join(root,'references/citation-graph.json')));
  assert.deepEqual(graph.nodes.map(n=>[n.id,n.citationCount]),[['new',1],['old',1]]);
  assert.equal(graph.edges.length,2);
  run([script,'--offline']);
  const rebuilt=JSON.parse(await fs.readFile(path.join(root,'references/citation-graph.json')));
  assert.deepEqual(rebuilt.edges,graph.edges);
  assert.deepEqual(rebuilt.nodes,graph.nodes);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
