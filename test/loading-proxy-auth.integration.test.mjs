import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {renderMacOnDemandProxy} from '../src/templates/macos-on-demand.mjs';
import {resolveDirectPosixService} from '../src/service-command.mjs';
import {shellQuote} from '../src/utils.mjs';

for (const [earlyLoading, launchKind] of [[false,'direct'],[true,'direct'],[false,'function'],[true,'alias']]) test(`loading proxy authenticates ${launchKind} with early loading ${earlyLoading}`, {timeout:15000,skip:process.platform==='win32' && launchKind!=='direct'}, async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),"omd-auth-test's "));
  const proxyPath=path.join(root,'proxy.mjs');
  const configPath=path.join(root,'config.json');
  const servicePath=path.join(root,'service.mjs');
  const launchUrlPath=path.join(root,'launch-url.txt');
  const logPath=path.join(root,'service.log');
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const origin=`http://127.0.0.1:${port}`;
  const token='fixture-launch-secret';
  await writeFile(proxyPath,renderMacOnDemandProxy());
  await writeFile(servicePath,`import http from 'node:http';
import {existsSync} from 'node:fs';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
const host=${JSON.stringify(`127.0.0.1:${port}`)};
const token=${JSON.stringify(token)};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(req.headers.host!==host){res.writeHead(403);res.end('wrong authority');return;}
 if(url.pathname==='/' && url.searchParams.get('token')===token){
  res.writeHead(303,{'location':'/','set-cookie':'dsh_session=fixture-cookie; HttpOnly; SameSite=Strict; Path=/','cache-control':'no-store'});res.end();return;
 }
 if(req.headers.cookie!=='dsh_session=fixture-cookie'){res.writeHead(401);res.end('authentication required');return;}
 if(url.pathname==='/plugins/'){
  if(req.url!=='/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=fixture'){res.writeHead(404);res.end();return;}
  res.setHeader('content-type','text/javascript');res.end('window.__ModuleLoader__.load({id:"bootstrap"})');return;
 }
 if(url.pathname==='/api/echo'){res.end(req.url);return;}
 if(url.pathname==='/api/test'){res.writeHead(200);res.end('authenticated api');return;}
 res.setHeader('content-type','text/html');
 res.end('<title>DeepSeek Harness</title><script>window.__DSH_BOOT__={"entries":[{"id":"ready","url":"/plugins/ready.js"}]}</script>');
});
function start(){
if(${earlyLoading} && !existsSync(${JSON.stringify(path.join(root,'start-backend'))})){setTimeout(start,20);return;}
server.listen(port,'127.0.0.1',()=>{
 process.stdout.write('dsh web: http://127.0.0.1:'+port+'/?tok');
 setTimeout(()=>process.stdout.write('en='+token+'\\n'),20);
});
}start();
`);
  let directService={executable:process.execPath,arguments:[servicePath],serviceKind:'dsh-web'};
  if(launchKind!=='direct'){
    const shell=path.join(root,'shell');
    const invocation=[process.execPath,servicePath].map(shellQuote).join(' ');
    const definition=launchKind==='function' ? `dsh() { ${invocation} "$@"; };` : `shopt -s expand_aliases; alias dsh=${shellQuote(invocation)};`;
    const script=definition+'\neval "$1"';
    await writeFile(shell,`#!/bin/sh\nprintf 'Shell banner\\n'\nexec /bin/bash --noprofile --norc -c ${shellQuote(script)} omd "$2"\n`,{mode:0o755});
    directService=await resolveDirectPosixService({serviceCommand:'dsh web --no-open',serviceShell:shell,servicePath:process.env.PATH,nodePath:process.execPath});
    assert.equal(directService.serviceKind,'dsh-web');
    assert.equal(directService.dshWebLaunch.kind,'posix-shell-command');
  }
  await writeFile(configPath,JSON.stringify({url:origin+'/',readyHost:'127.0.0.1',readyPort:port,timeoutSeconds:8,
    serviceCommand:'dsh web --no-open',workingDirectory:root,logPath,launchUrlPath,readyPath:path.join(root,'ready'),errorPath:path.join(root,'error'),
    earlyLoading,waitForWindowReveal:earlyLoading,minimumLoadingMilliseconds:0,loadingIconPath:path.resolve('assets/windows-icon-master-v2.png'),
    directService}));
  const env={...process.env};delete env.OMD_LISTEN_FD;
  const proxy=spawn(process.execPath,[proxyPath,configPath],{env,windowsHide:true,stdio:'ignore'});
  t.after(async()=>{
    if(proxy.exitCode===null){
      if(process.platform==='win32')spawnSync('taskkill.exe',['/pid',String(proxy.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
      else proxy.kill('SIGTERM');
      if(proxy.exitCode===null)await once(proxy,'exit');
    }
    await rm(root,{recursive:true,force:true});
  });
  let bootstrapCookie;
  if(earlyLoading){
    let earlyUrl;
    const deadline=Date.now()+5000;
    while(!earlyUrl && Date.now()<deadline){try{earlyUrl=await readFile(launchUrlPath,'utf8');}catch{await new Promise(r=>setTimeout(r,20));}}
    assert.ok(earlyUrl,'launch surface waited for backend startup');
    const loading=await fetch(earlyUrl);
    assert.equal(loading.status,200);
    assert.match(await loading.text(),/id="omd-launch"/);
    bootstrapCookie=loading.headers.get('set-cookie').split(';',1)[0];
    assert.equal((await fetch(origin+'/__omd_ready')).status,503);
    await writeFile(path.join(root,'start-backend'),'go');
  }
  let ready=false;
  const deadline=Date.now()+10000;
  while(Date.now()<deadline && proxy.exitCode===null){try{ready=(await fetch(origin+'/__omd_ready')).status===204;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,await readFile(logPath,'utf8'));
  const launchUrl=await readFile(launchUrlPath,'utf8');
  assert.equal(new URL(launchUrl).origin,origin);
  assert.equal(new URL(launchUrl).searchParams.get('token'),earlyLoading ? null : token);
  assert.equal((await fetch(origin+'/?__omd_launch=1',{headers:{accept:'text/html'}})).status,401);
  assert.equal((await fetch(origin+'/api/test')).status,401);
  let login;
  if(earlyLoading){
    const anonymous=await fetch(origin+'/__omd_browser_ready');
    assert.equal(anonymous.status,401);
    assert.equal(anonymous.headers.get('set-cookie'),null);
    const beforeReveal=await fetch(origin+'/__omd_browser_ready',{headers:{cookie:bootstrapCookie}});
    assert.equal(beforeReveal.status,503);
    assert.equal(beforeReveal.headers.get('set-cookie'),null);
    await fetch(origin+'/__omd_window_visible',{method:'POST'});
    login=await fetch(origin+'/__omd_browser_ready',{headers:{cookie:bootstrapCookie}});
    assert.equal(login.status,204,'a ready visible window must not fall back to a fixed 900 ms loading delay');
    assert.equal((await fetch(origin+'/api/test',{headers:{cookie:bootstrapCookie}})).status,401);
  }else{
    const waiting=await fetch(origin+'/__omd_browser_ready');
    assert.equal(waiting.status,401);
    assert.equal(waiting.headers.get('set-cookie'),null);
    login=await fetch(launchUrl,{redirect:'manual'});
    assert.equal(login.status,303);
  }
  const cookie=login.headers.get('set-cookie').split(';',1)[0];
  if(!earlyLoading) assert.equal((await fetch(origin+'/__omd_browser_ready',{headers:{cookie}})).status,204);
  const document=await fetch(origin+'/?__omd_launch=1',{headers:{cookie,accept:'text/html'}});
  assert.equal(document.status,200);
  assert.match(await document.text(),/__DSH_BOOT__/);
  assert.equal(await fetch(origin+'/api/test',{headers:{cookie}}).then(r=>r.text()),'authenticated api');
  const asset=await fetch(origin+'/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=fixture',{headers:{cookie}});
  assert.equal(asset.status,200,'proxy changed the DSH combo asset URL');
  assert.match(await asset.text(),/__ModuleLoader__\.load/);
  const rawQuery='/api/echo?space=a%20b&repeat=1&repeat=2&empty=&escaped=%2f';
  assert.equal(await fetch(origin+rawQuery,{headers:{cookie}}).then(r=>r.text()),rawQuery);
  assert.ok(!(await readFile(logPath,'utf8')).includes(token),'launch token leaked into log');
});
