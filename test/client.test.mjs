import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, cp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import { Api } from '../src/network.mjs';
import { tradingState, applyWallet, sseEvents, outcomeFor } from '../src/state.mjs';
import { preflight } from '../src/preflight.mjs';
import { signOrder, DOMAIN, TYPES } from '../src/protocol.mjs';
import { Store } from '../src/storage.mjs';
import defaults from '../config.mjs';

// 此密钥只用于测试，任何人都知道，绝不能充值或用于真实账户。
const KEY='0x'+'11'.repeat(32), signer=privateKeyToAccount(KEY);
const WALLET='0x'+'22'.repeat(20), ID='0x'+'33'.repeat(32);
const raw=()=>({schemaVersion:1,tradingPaused:false,minimumTradeSizeRaw:'1000000000000000000',
  minimumOpenNotionalRaw:'1000000000000000000',intake:[1,'0','1000000000000000000000',[]],
  instruments:[[0,'BTC',0,'10',true,false,false,false,false,null,null,null,'1','1',1000,
    '100000000000000000000000','0','0','1','0','0','100000000000000000000000','100000000000000000000000']]});
const frame=()=>({address:WALLET,accountRevision:1,indexedThroughTimestamp:Math.floor(Date.now()/1000),
  sessionKeys:[[signer.address.toLowerCase(),String(Math.floor(Date.now()/1000)+7200)]],
  balance:'100000000000000000000',locked:'0',queueRevision:'0',
  funds:{availableBalance:'100000000000000000000',reservedBalance:'0',availableQueued:'0',reservedQueued:'0'},
  openPositions:[],operations:[]});
const config={...defaults,wallet:WALLET,margin:'2',leverage:2,maxMargin:'5',maxNotional:'10',maxTotalMargin:'5',maxLeverage:3};

test('intake 暂停即使全局未暂停也会阻止下单',()=>{
  const data=raw(); data.intake[3]=['openPosition'];
  assert.throws(()=>preflight(config,tradingState(data),frame(),signer.address),{code:'PAUSED'});
});
test('拒绝过期会话、过旧状态、超限仓位和不属于自己的平仓 ID',()=>{
  const state=tradingState(raw()), wallet=frame();
  assert.throws(()=>preflight({...config,maxMargin:'1'},state,wallet,signer.address),{code:'RISK_LIMIT'});
  wallet.sessionKeys[0][1]='1';
  assert.throws(()=>preflight(config,state,wallet,signer.address),{code:'SESSION_EXPIRING'});
  assert.throws(()=>preflight({...config,action:'close',positionIds:['99']},state,frame(),signer.address),{code:'POSITION_MISSING'});
  const stale=frame(); stale.indexedThroughTimestamp=1;
  assert.throws(()=>preflight(config,state,stale,signer.address),{code:'STALE_INDEX'});
});
test('开仓签名能恢复到 Session Key，数字序列化无精度损失',async()=>{
  const message={...preflight(config,tradingState(raw()),frame(),signer.address),nonce:2n**180n,deadline:BigInt(Math.floor(Date.now()/1000)+300)};
  const result=await signOrder(signer,'open',message), s=result.body.signed;
  const sig=s.r+s.s.slice(2)+(Number(s.v)).toString(16);
  const address=await recoverTypedDataAddress({domain:DOMAIN,types:{OpenPosition:TYPES.OpenPosition},primaryType:'OpenPosition',message,signature:sig});
  assert.equal(address,signer.address); assert.equal(s.nonce,String(2n**180n));
  assert.equal(s.size,'2000000000000000000'); assert.match(result.intentId,/^0x[0-9a-f]{64}$/);
});
test('平仓签名使用 Close 和指定 ID',async()=>{
  const message={user:WALLET,positionIds:[9n,10n],nonce:3n,deadline:1000n};
  const result=await signOrder(signer,'close',message);
  assert.equal(result.body.action,'closePositions'); assert.deepEqual(result.body.signed.positionIds,['9','10']);
});
test('SSE 分片、CRLF、多行 data 与增量缺包',async()=>{
  const wire=': hi\r\nevent: wallet\r\ndata: {"a":\r\ndata: 1}\r\n\r\n';
  async function* chunks(){for(const char of wire)yield new TextEncoder().encode(char);}
  const events=[]; for await(const event of sseEvents(chunks()))events.push(event);
  assert.equal(events[0].event,'wallet'); assert.deepEqual(JSON.parse(events[0].data),{a:1});
  const state=applyWallet(null,frame(),WALLET);
  assert.throws(()=>applyWallet(state,{address:WALLET,accountRevision:3,baseAccountRevision:2},WALLET),{code:'STREAM_GAP'});
});
test('订单消失不等于成交；明确 outcome 或持仓 intentId 才可确认',()=>{
  const state=applyWallet(null,frame(),WALLET);
  assert.equal(outcomeFor(state,ID),'unknown');
  const patch={address:WALLET,accountRevision:2,baseAccountRevision:1,state:{},
    addedPositions:[],removedPositionIds:[],addedOperations:[],removedOperationIds:[],intentOutcomes:[[ID,'succeeded']]};
  assert.equal(outcomeFor(applyWallet(state,patch,WALLET),ID),'succeeded');
});
test('POST 超时只有一次请求，回执 ID 不匹配不当作成功',async()=>{
  let calls=0; const api=new Api(config,async()=>{calls++;throw new TypeError('timeout');});
  await assert.rejects(api.submit({intentId:ID,body:{action:'openPosition'}}),{code:'SUBMIT_UNCERTAIN'});
  assert.equal(calls,1);
  const wrong=new Api(config,async()=>Response.json({intentId:'wrong',action:'openPosition',queueRevision:'1'}));
  await assert.rejects(wrong.submit({intentId:ID,body:{action:'openPosition'}}),{code:'SUBMIT_UNCERTAIN'});
});
test('持久化 nonce 不复用，进程锁阻止并发写入',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'papertrade-store-'));
  const store=new Store(dir,WALLET), second=new Store(dir,WALLET);
  try{await store.lock(); const n=await store.nonce(); assert.equal(await store.nonce(),n+1n);
    await assert.rejects(second.lock(),{code:'LOCKED'});
    await store.save('test',{intentId:ID,status:'unknown'});
    assert.equal((await store.load('test')).status,'unknown');
    await store.save('test',{requestId:'test',intentId:ID,status:'unknown'});
    assert.deepEqual(await store.unresolved(),['test']);
  }finally{await store.unlock();await rm(dir,{recursive:true,force:true});}
});

// 用隔离的临时项目运行真实 CLI；所有 fetch 都被内存模拟器拦截。
// 此测试绝不会触达真实交易所，不加载任何用户凭证。
const execute=promisify(execFile), project=fileURLToPath(new URL('..',import.meta.url));
async function cliFixture(mode,timeout=false){
  const dir=await mkdtemp(path.join(os.tmpdir(),'papertrade-cli-'));
  await cp(path.join(project,'src'),path.join(dir,'src'),{recursive:true});
  await symlink(path.join(project,'node_modules'),path.join(dir,'node_modules'),'dir');
  await writeFile(path.join(dir,'config.mjs'),'export default '+JSON.stringify({...config,mode,confirmationTimeoutMs:500})+';');
  await writeFile(path.join(dir,'.session-key'),KEY,{mode:0o600});
  const bootstrap=`import { appendFileSync } from 'node:fs';
    import { signOrder, BUILD } from './src/protocol.mjs';
    import { privateKeyToAccount } from 'viem/accounts';
    let controller;
    const frame=${JSON.stringify(frame())};
    globalThis.fetch=async(url,options={})=>{
      if(url.includes('/assets/build-')) return new Response('var e=\x60'+BUILD+'\x60;export{e as t};');
      if(url.endsWith('/state/trading'))return Response.json(${JSON.stringify(raw())});
      if(url.includes('/state/user/live')) {
        return new Response(new ReadableStream({start(c){controller=c;
          c.enqueue(new TextEncoder().encode('event: wallet\\ndata: '+JSON.stringify(frame)+'\\n\\n'));
          options.signal.addEventListener('abort',()=>c.close(),{once:true});
        }}),{headers:{'content-type':'text/event-stream'}});
      }
      if(url.endsWith('/intents')&&options.method==='POST'){
        appendFileSync(${JSON.stringify(path.join(dir,'posts'))},'POST\\n');
        if(${timeout})throw new TypeError('timeout');
        const body=JSON.parse(options.body),s=body.signed;
        const message={user:s.user,instrumentId:Number(s.instrumentId),isLong:s.isLong,size:BigInt(s.size),leverage:Number(s.leverage),useDebt:s.useDebt,nonce:BigInt(s.nonce),deadline:BigInt(s.deadline)};
        const signed=await signOrder(privateKeyToAccount(${JSON.stringify(KEY)}),'open',message);
        setTimeout(()=>controller.enqueue(new TextEncoder().encode('event: wallet\\ndata: '+JSON.stringify({
          address:frame.address,accountRevision:2,baseAccountRevision:1,state:{},
          addedPositions:[],removedPositionIds:[],addedOperations:[],removedOperationIds:[],intentOutcomes:[[signed.intentId,'succeeded']]
        })+'\\n\\n')),20);
        return Response.json({intentId:signed.intentId,action:body.action,queueRevision:'1',state:'queued'});
      }
      throw Error('Unexpected network request');
    };`;
  await writeFile(path.join(dir,'mock.mjs'),bootstrap);
  return {dir,run:()=>execute(process.execPath,['--import',path.join(dir,'mock.mjs'),path.join(dir,'src/cli.mjs')],{timeout:10000})};
}
test('CLI dry-run 不 POST、不生成订单；live 成功后重复运行不再提交',async()=>{
  const dry=await cliFixture('dry-run');
  try{assert.match((await dry.run()).stdout,/演练完成/);await assert.rejects(readFile(path.join(dry.dir,'posts')),{code:'ENOENT'});}
  finally{await rm(dry.dir,{recursive:true,force:true});}
  const live=await cliFixture('live');
  try{assert.match((await live.run()).stdout,/succeeded/);await live.run();
    assert.equal(await readFile(path.join(live.dir,'posts'),'utf8'),'POST\n');}
  finally{await rm(live.dir,{recursive:true,force:true});}
});
test('CLI POST 超时后退出 3，再次执行仍不重发',async()=>{
  const fixture=await cliFixture('live',true);
  try{await assert.rejects(fixture.run(),e=>e.code===3);await assert.rejects(fixture.run(),e=>e.code===3);
    assert.equal(await readFile(path.join(fixture.dir,'posts'),'utf8'),'POST\n');}
  finally{await rm(fixture.dir,{recursive:true,force:true});}
});
