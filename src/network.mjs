import { BASE, BUILD, BUILD_PATH } from './protocol.mjs';
import { ClientError, ensure } from './errors.mjs';
import { sseEvents, applyWallet, outcomeFor } from './state.mjs';
const sleep = ms => new Promise(r=>setTimeout(r,ms));

export class Api {
  constructor(config, fetcher = fetch) { this.config=config; this.fetch=fetcher; }
  // 只有只读 GET 自动重试。POST 不在这个函数内，永远不自动重试。
  async get(path, text = false) {
    for (let attempt=0; attempt<3; attempt++) {
      try {
        const r=await this.fetch(BASE+path, { redirect:'error', cache:'no-store',
          headers:{ Accept:text?'text/javascript':'application/json' },
          signal:AbortSignal.timeout(this.config.requestTimeoutMs) });
        if ([408,429,502,503,504].includes(r.status) && attempt<2) {
          const after=Number(r.headers.get('retry-after'));
          await r.body?.cancel();
          await sleep(Number.isFinite(after)&&after>0 ? Math.min(after*1000,5000) : 500*2**attempt);
          continue;
        }
        ensure(r.ok,'HTTP_GET',`只读接口返回 HTTP ${r.status}；不尝试绕过认证或防护。`);
        if (text) return await r.text();
        return await r.json();
      } catch(e) {
        if (e instanceof ClientError) throw e;
        if (attempt===2) throw new ClientError('NETWORK_GET','只读请求失败或返回无效 JSON，请检查网络后重试。');
        await sleep(500*2**attempt);
      }
    }
  }
  async verifyBuild() {
    const source=await this.get(BUILD_PATH,true);
    ensure(source.trim()===`var e=\`${BUILD}\`;export{e as t};`,'BUILD_CHANGED','已核对的 build 资源发生变化，需要重新核对协议。');
    // 老资源可能继续保留，所以此检查不是“当前版本一定未变”的保证；
    // 服务端对 X-Papertrade-Build 的拒绝同样必须停止处理。
  }
  async submit(prepared) {
    try {
      const r=await this.fetch(BASE+'/intents', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(this.config.requestTimeoutMs),
        headers:{Accept:'application/json','Content-Type':'application/json','X-Papertrade-Build':BUILD},
        body:JSON.stringify(prepared.body),
      });
      const data=await r.json();
      ensure(r.ok && !data.error && data.ok!==false,'SUBMIT_UNCERTAIN',
        `提交返回 HTTP ${r.status}，结果需核对；不会自动重发。`);
      ensure(data.intentId===prepared.intentId && data.action===prepared.body.action &&
        typeof data.queueRevision==='string' && /^\d+$/.test(data.queueRevision),
        'SUBMIT_UNCERTAIN','回执与本地订单不匹配，结果需核对；不会自动重发。');
      return { intentId:data.intentId, action:data.action, state:data.state, queueRevision:data.queueRevision };
    } catch(e) {
      if (e instanceof ClientError) throw e;
      // 超时、断网、非 JSON、重定向都可能发生在服务端已经受理之后。
      throw new ClientError('SUBMIT_UNCERTAIN','提交连接中断或回执无法解析；订单可能已经受理。');
    }
  }
}

export class WalletFeed {
  constructor(api,wallet) {
    this.api=api; this.wallet=wallet; this.state=null; this.error=null;
    this.controller=new AbortController(); this.outcomes=new Map(); this.lastActivity=Date.now();
  }
  async start() {
    this.task=this.read().catch(e=>{ this.error=e instanceof ClientError?e:new ClientError('STREAM','账户流断开，请用 status 重新核对。'); });
    const end=Date.now()+this.api.config.requestTimeoutMs;
    while (!this.state) {
      if (this.error) throw this.error;
      if (Date.now()>end) { this.close(); throw new ClientError('STREAM_TIMEOUT','未及时收到完整账户快照。'); }
      await sleep(50);
    }
    return this;
  }
  async read() {
    const r=await this.api.fetch(BASE+'/state/user/live?wallet='+encodeURIComponent(this.wallet),{
      headers:{Accept:'text/event-stream'}, redirect:'error', cache:'no-store', signal:this.controller.signal,
    });
    ensure(r.ok && (r.headers.get('content-type')??'').includes('text/event-stream'),
      'STREAM_HTTP',`账户流返回 HTTP ${r.status} 或非 SSE 内容。`);
    for await (const event of sseEvents(r.body)) {
      this.lastActivity=Date.now();
      if (event.event!=='wallet') continue;
      let frame;
      try { frame=JSON.parse(event.data); } catch { throw new ClientError('STREAM_JSON','账户流 JSON 无效。'); }
      this.state=applyWallet(this.state,frame,this.wallet);
      for (const [id,value] of this.state.intentOutcomes) this.outcomes.set(id,value);
    }
    if (!this.controller.signal.aborted) throw new ClientError('STREAM_ENDED','账户流提前结束。');
  }
  current() {
    if (this.error) throw this.error;
    ensure(this.state && Date.now()-this.lastActivity<35000,'STREAM_STALE','账户流没有保持活跃。');
    return this.state;
  }
  async wait(intentId, timeoutMs) {
    const end=Date.now()+timeoutMs;
    do {
      const state=this.current();
      const result=this.outcomes.get(intentId) ?? outcomeFor(state,intentId);
      if (['succeeded','failed','expired','cancelled'].includes(result)) return result;
      await sleep(200);
    } while (Date.now()<end);
    // 没找到不是失败；即使 deadline 已过，也可能是索引/回执延迟。
    return 'unknown';
  }
  close() { this.controller.abort(); }
}
