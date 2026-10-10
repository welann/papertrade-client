import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUnits } from 'viem';
import config from '../config.mjs';
import { Api, WalletFeed } from './network.mjs';
import { tradingState } from './state.mjs';
import { validateConfig, preflight } from './preflight.mjs';
import { Store, readSessionKey, digest } from './storage.mjs';
import { signOrder } from './protocol.mjs';
import { ClientError, ensure, safeMessage } from './errors.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const c={...config,wallet:typeof config.wallet==='string'?config.wallet.toLowerCase():''};
const command=process.argv[2]??'run';
let feed,store,interrupted=false;
// 不在 SIGINT 时马上 exit，给 finally 释放锁和主流程记录不确定结果的机会。
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{interrupted=true;feed?.close();});
const log=(message,data)=>console.log(message,data??'');

async function inspect(api) {
  const state=tradingState(await api.get('/state/trading'));
  log('只读检查：没有加载私钥，没有发送订单。');
  log('交易暂停 / 停用操作：',{paused:state.paused,disabledActions:state.disabledActions});
  log('交易所最低额度：',{margin:formatUnits(state.minMargin,18),notional:formatUnits(state.minNotional,18)});
  log('市场：',state.markets.map(m=>({symbol:m.symbol,openable:m.openable,maxLeverage:m.maxLeverage,
    maxNotional:formatUnits(m.maxNotional,18)})));
}
function fingerprint() {
  // 订单身份与额度限制分开：调整风控上限不等于创建了新的逻辑订单。
  return digest(c.action==='open' ? [c.wallet,c.action,c.symbol,c.side,c.margin,c.leverage] :
    [c.wallet,c.action,[...c.positionIds].sort()]);
}
async function connect(api) {
  feed=new WalletFeed(api,c.wallet);
  await feed.start();
}
async function reconcile(api,record) {
  if(['succeeded','failed','expired','cancelled'].includes(record.status)) {
    log('本地已保存终态，不会重新提交：',{intentId:record.intentId,status:record.status});
    process.exitCode=record.status==='succeeded'?0:2; return;
  }
  if(!feed) await connect(api);
  let result='unknown';
  try { result=await feed.wait(record.intentId,c.confirmationTimeoutMs); }
  catch(e) { log(safeMessage(e)); }
  record.status=result; record.updatedAt=new Date().toISOString();
  await store.save(c.requestId,record);
  log('订单核对结果：',{requestId:c.requestId,intentId:record.intentId,status:result});
  if(result==='unknown') {
    log('结果不确定。订单可能已成交、仍排队或尚未被索引；请运行 npm run status 或检查官网。不要更换 requestId 重下同一单。');
    process.exitCode=3;
  } else process.exitCode=result==='succeeded'?0:2;
}
async function main() {
  ensure(['run','inspect','status'].includes(command),'COMMAND','可用命令：npm start、npm run inspect、npm run status。');
  validateConfig(c,{publicOnly:command==='inspect',statusOnly:command==='status'});
  const api=new Api(c);
  if(command==='inspect') return inspect(api);
  // status 也使用锁，避免与正在提交的进程同时改写同一订单记录。
  store=new Store(path.resolve(root,c.stateDirectory),c.wallet);
  await store.lock();
  const existing=await store.load(c.requestId);
  if(command==='status') {
    ensure(existing,'NO_ORDER','该 requestId 没有本地实盘记录。');
    return reconcile(api,existing);
  }
  if(existing) {
    ensure(existing.fingerprint===fingerprint(),'ID_REUSED','此 requestId 已用于不同参数；不会覆盖订单或再次发送。');
    log('检测到已有订单记录，转为核对状态，不会签名或再次提交。');
    return reconcile(api,existing);
  }
  const pending=await store.unresolved();
  ensure(pending.length===0,'UNRESOLVED_ORDER',`此账户仍有结果未确定的订单（requestId: ${pending.join(', ')}）。先把配置切回对应 requestId，运行 npm run status。`);
  await api.verifyBuild();
  const key=await readSessionKey(path.resolve(root,c.sessionKeyFile));
  let account;
  try { account=privateKeyToAccount(key); }
  catch { throw new ClientError('KEY_INVALID','Session Key 不是有效的 secp256k1 私钥。'); }
  ensure(account.address.toLowerCase()!==c.wallet,'MASTER_KEY','检测到主钱包私钥；本程序只接受独立 Session Key。');
  await connect(api);
  const marketState=tradingState(await api.get('/state/trading'));
  const draft=preflight(c,marketState,feed.current(),account.address);
  log('预检通过：',c.action==='open'?{
    mode:c.mode,requestId:c.requestId,symbol:c.symbol,side:c.side,margin:c.margin,
    leverage:c.leverage,notional:formatUnits(draft.size*BigInt(c.leverage),18),
  }:{mode:c.mode,requestId:c.requestId,positionIds:c.positionIds});
  if(c.mode==='dry-run') { log('演练完成：没有签名、没有消耗 nonce、没有 POST。'); return; }
  ensure(!interrupted,'INTERRUPTED','已收到停止信号，未提交。');
  // 在签名前重新检查最新账户状态；预检无法保证下一毫秒的服务端状态。
  preflight(c,marketState,feed.current(),account.address);
  const nonce=await store.nonce();
  const deadline=BigInt(Math.floor(Date.now()/1000)+c.deadlineSeconds);
  const prepared=await signOrder(account,c.action,{...draft,nonce,deadline});
  // 先落盘，再发网络请求。即使发送后崩溃，重启也不会制造第二笔订单。
  const record={version:1,requestId:c.requestId,fingerprint:fingerprint(),status:'prepared',
    createdAt:new Date().toISOString(),intentId:prepared.intentId,nonce:String(nonce),
    deadline:String(deadline),body:prepared.body};
  await store.save(c.requestId,record);
  ensure(!interrupted,'INTERRUPTED','已停止；订单记录已保留，没有继续提交。');
  record.status='submitting'; await store.save(c.requestId,record);
  try {
    record.ack=await api.submit(prepared);
    record.status='accepted'; await store.save(c.requestId,record);
    log('服务端已受理，等待执行结果：',{intentId:record.intentId});
  } catch(e) {
    record.status='unknown'; await store.save(c.requestId,record);
    log(safeMessage(e));
    // 只有只读状态查询；绝不再次调用 submit。
  }
  await reconcile(api,record);
}

try { await main(); }
catch(e) { console.error(safeMessage(e)); process.exitCode=interrupted?130:1; }
finally {
  feed?.close();
  if(store) try { await store.unlock(); } catch { console.error('释放进程锁失败，请按 README 检查。'); process.exitCode=1; }
}
