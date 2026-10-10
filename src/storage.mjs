import { open, mkdir, readFile, rename, unlink, lstat, readdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { ClientError, ensure } from './errors.mjs';
import { DOMAIN } from './protocol.mjs';
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function atomicJson(file,value) {
  const temp=file+'.'+randomBytes(6).toString('hex')+'.tmp';
  const handle=await open(temp,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(value,null,2)+'\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp,file);
  // fsync 目录，确保掉电时 rename 也尽可能持久化；失败即停止，不继续 POST。
  const directory=await open(path.dirname(file),'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export class Store {
  constructor(root,wallet) { this.dir=path.join(root,digest([DOMAIN.chainId,DOMAIN.verifyingContract,wallet])); }
  async lock() {
    await mkdir(this.dir,{recursive:true,mode:0o700});
    this.lockFile=path.join(this.dir,'process.lock');
    try { this.handle=await open(this.lockFile,'wx',0o600); }
    catch(e) { if(e.code==='EEXIST') throw new ClientError('LOCKED','已有实例或异常退出留下的 process.lock；确认进程已退出后按 README 恢复。'); throw e; }
    await this.handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  }
  async unlock() { if(this.handle){ await this.handle.close(); await unlink(this.lockFile); this.handle=null; } }
  file(id) { return path.join(this.dir,'order-'+digest(id)+'.json'); }
  async load(id) {
    try { return JSON.parse(await readFile(this.file(id),'utf8')); }
    catch(e) { if(e.code==='ENOENT') return null; throw new ClientError('JOURNAL','订单记录无法读取；不要删除后重下。'); }
  }
  save(id,value) { return atomicJson(this.file(id),value); }
  async unresolved() {
    const files=(await readdir(this.dir)).filter(x=>/^order-[a-f0-9]{64}\.json$/.test(x));
    const pending=[];
    for(const file of files) {
      let record;
      try { record=JSON.parse(await readFile(path.join(this.dir,file),'utf8')); }
      catch { throw new ClientError('JOURNAL','存在损坏的历史订单记录，需要先核对，不能继续开新单。'); }
      if(!['succeeded','failed','expired','cancelled'].includes(record.status)) pending.push(record.requestId);
    }
    return pending;
  }
  async nonce() {
    const file=path.join(this.dir,'nonce.json'); let next;
    try {
      const data=JSON.parse(await readFile(file,'utf8'));
      ensure(typeof data.next==='string'&&/^\d+$/.test(data.next),'NONCE','nonce 文件损坏。'); next=BigInt(data.next);
    } catch(e) {
      if(e.code!=='ENOENT') throw e;
      // 随机 128 位前缀 + 64 位计数空间，避免与网页的小整数 nonce 撞号。
      // nonce 是签名防重放值，不是 EOA 的交易次数。持久化后永不回退。
      next=BigInt('0x'+randomBytes(16).toString('hex'))<<64n;
    }
    ensure(next>=0n&&next<(1n<<256n)-1n,'NONCE','nonce 超出 uint256。');
    await atomicJson(file,{next:String(next+1n)}); return next;
  }
}
export async function readSessionKey(file) {
  let stat;
  try { stat=await lstat(file); } catch { throw new ClientError('KEY_FILE','找不到 sessionKeyFile；请按 README 在本机创建。'); }
  ensure(stat.isFile()&&!stat.isSymbolicLink(),'KEY_FILE','密钥路径必须是普通文件，不能是符号链接。');
  ensure((stat.mode&0o077)===0,'KEY_PERMISSIONS','密钥文件权限过宽，请执行 chmod 600 .session-key。');
  const key=(await readFile(file,'utf8')).trim();
  ensure(/^0x[0-9a-fA-F]{64}$/.test(key),'KEY_FORMAT','密钥文件必须只包含一个 0x 开头、64 位十六进制的 Session Key。');
  return key;
}
