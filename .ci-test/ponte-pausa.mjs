import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(),'ix-pausa-')); fs.mkdirSync(path.join(HOME,'data'),{recursive:true});
process.env.IDEAX_HOME=HOME; process.env.IDEAX_NO_OPEN='1';
const abb=[]; const ntfy=http.createServer((req,res)=>{ const u=new URL(req.url,'http://x'); const p=u.pathname.replace(/^\/+/,'').split('/');
  if(req.method==='GET'&&p[1]==='json'){res.writeHead(200);res.write(JSON.stringify({id:'o',event:'open'})+'\n');const s={t:new Set(p[0].split(',')),res};abb.push(s);req.on('close',()=>{const i=abb.indexOf(s);if(i>=0)abb.splice(i,1)});return;}
  if(req.method==='POST'){for(const s of abb)if(s.t.has(p[0]))s.res.write(JSON.stringify({id:'m'+Date.now(),event:'message',topic:p[0],message:'x'})+'\n');res.writeHead(200);res.end('{}');return;} res.writeHead(404);res.end(); });
let get=0; const app=http.createServer((req,res)=>{ const u=new URL(req.url,'http://x');
  if(u.pathname==='/api/ponte/ideax/lavori'){get++; res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({lavori:[],pausa:true,ritenta_fra_s:60})); return;}
  res.writeHead(200);res.end('{}'); });
await new Promise(r=>ntfy.listen(0,'127.0.0.1',r)); await new Promise(r=>app.listen(0,'127.0.0.1',r));
process.env.IDEAX_NTFY_BASE=`http://127.0.0.1:${ntfy.address().port}`; const appUrl=`http://127.0.0.1:${app.address().port}`; const KEY='k-pausa';
fs.writeFileSync(path.join(HOME,'data','settings.json'),JSON.stringify({systems:[{id:'a1',name:'Pausa',url:appUrl,path:'/api/ponte/ideax',key:KEY,enabled:true}]}));
const sis=await import('../lib/systems.js'); const sv=await import('../lib/sveglia.js');
const ok=(c,m)=>{console.log(c?`✅ ${m}`:`❌ ${m}`); if(!c)process.exit(1);};
sis.startAll(); await new Promise(r=>setTimeout(r,1500));
ok(get===1, `avvio: 1 controllo, l'app ha detto pausa (GET=${get})`);
await sv.pubblica(sv.topicPer(KEY),'x'); await new Promise(r=>setTimeout(r,1500));
ok(get===1, `sveglia durante la pausa: NESSUNA nuova richiesta (GET ancora ${get})`);
console.log('\n🎉 Back-off pausa: l\'host in pausa non viene ribussato finché non scade.'); process.exit(0);
