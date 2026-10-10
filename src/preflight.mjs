import { parseUnits, formatUnits, isAddress } from 'viem';
import { ensure } from './errors.mjs';
import { actionName } from './protocol.mjs';
export function amount(value,label) {
  ensure(typeof value==='string' && /^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value),'CONFIG',`${label} 必须填写十进制金额字符串。`);
  const result=parseUnits(value,18);
  ensure(result>0n && result<(1n<<128n),'CONFIG',`${label} 金额超出范围。`);
  return result;
}
export function validateConfig(c,{publicOnly=false,statusOnly=false}={}) {
  for (const k of ['requestTimeoutMs','confirmationTimeoutMs','maxIndexAgeSeconds']) {
    ensure(Number.isSafeInteger(c[k])&&c[k]>0&&c[k]<=3_600_000,'CONFIG',`${k} 必须为合理正整数。`);
  }
  if (publicOnly) return;
  ensure(isAddress(c.wallet) && !/^0x0{40}$/i.test(c.wallet),'CONFIG','请在 config.mjs 填写主钱包地址 wallet。');
  ensure(typeof c.requestId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(c.requestId),'CONFIG','requestId 只允许 1–80 位字母、数字、下划线和短横线。');
  if(statusOnly) return; // 查已有订单不需要私钥，也不要求重新填写开仓参数。
  ensure(['dry-run','live'].includes(c.mode),'CONFIG','mode 必须为 dry-run 或 live。');
  ensure(['open','close'].includes(c.action),'CONFIG','action 必须为 open 或 close。');
  ensure(Number.isSafeInteger(c.deadlineSeconds)&&c.deadlineSeconds>=30&&c.deadlineSeconds<=3600,'CONFIG','deadlineSeconds 范围为 30–3600。');
  ensure(Number.isSafeInteger(c.sessionSafetySeconds)&&c.sessionSafetySeconds>=0&&c.sessionSafetySeconds<=3600,'CONFIG','sessionSafetySeconds 无效。');
  ensure(typeof c.allowExistingPositions==='boolean','CONFIG','allowExistingPositions 必须为布尔值。');
  if(c.action==='open') {
    ensure(['BTC','ETH'].includes(c.symbol)&&['long','short'].includes(c.side),'CONFIG','symbol 或 side 无效。');
    for(const k of ['margin','maxMargin','maxNotional','maxTotalMargin']) amount(c[k],k);
    for(const k of ['leverage','maxLeverage']) ensure(Number.isSafeInteger(c[k])&&c[k]>=1&&c[k]<=1000,'CONFIG',`${k} 必须为 1–1000 的整数。`);
  } else {
    ensure(Array.isArray(c.positionIds)&&c.positionIds.length>0&&c.positionIds.length<=12&&
      c.positionIds.every(x=>typeof x==='string'&&/^(0|[1-9]\d*)$/.test(x)&&BigInt(x)<(1n<<256n))&&
      new Set(c.positionIds).size===c.positionIds.length,'CONFIG','平仓需提供 1–12 个不重复的 positionIds 字符串。');
  }
}
export function preflight(c,trading,wallet,sessionAddress,now=Math.floor(Date.now()/1000)) {
  ensure(!trading.disabledActions.includes(actionName(c.action)),'PAUSED','该操作的 relayer 入口已暂停。');
  ensure(Math.abs(now-wallet.indexedThroughTimestamp)<=c.maxIndexAgeSeconds,'STALE_INDEX','账户索引过旧或本机时间不准确。');
  const session=wallet.sessionKeys.find(([address])=>address===sessionAddress.toLowerCase());
  ensure(session,'SESSION_UNREGISTERED','此 Session Key 未在该主钱包下注册，或已撤销；请在官方页面完成授权。');
  ensure(BigInt(session[1])>BigInt(now+c.deadlineSeconds+c.sessionSafetySeconds),'SESSION_EXPIRING','会话即将过期，无法覆盖此次订单有效期。');
  // 单次示例保守处理：存在任何排队操作时先等它完成，避免余额/持仓竞态。
  ensure(wallet.operations.length===0,'PENDING_OPERATIONS','账户仍有排队操作，请完成后再运行。');
  if(c.action==='close') {
    const owned=new Set(wallet.openPositions.map(p=>p[0]));
    ensure(c.positionIds.every(id=>owned.has(id)),'POSITION_MISSING','至少一个 positionId 不属于当前账户的开放持仓。');
    return { user:c.wallet.toLowerCase(), positionIds:c.positionIds.map(BigInt) };
  }
  ensure(!trading.paused,'PAUSED','协议交易已暂停。');
  const market=trading.markets.find(m=>m.symbol===c.symbol);
  ensure(market?.openable,'MARKET_CLOSED','该市场不可开仓。');
  ensure(market.id===({BTC:0,ETH:1})[c.symbol],'DEPLOYMENT_CHANGED','市场编号与已核对部署不匹配。');
  const size=amount(c.margin,'margin'), notional=size*BigInt(c.leverage);
  ensure(size>=trading.minMargin,'MIN_MARGIN',`低于交易所最低保证金 ${formatUnits(trading.minMargin,18)}。不会自动增加金额。`);
  ensure(notional>=trading.minNotional,'MIN_NOTIONAL',`低于交易所最低名义价值 ${formatUnits(trading.minNotional,18)}。不会自动提高杠杆。`);
  ensure(size<=amount(c.maxMargin,'maxMargin') && notional<=amount(c.maxNotional,'maxNotional'),'RISK_LIMIT','超过你设置的单笔保证金或名义价值上限。');
  ensure(c.leverage<=Math.min(c.maxLeverage,market.maxLeverage),'LEVERAGE_LIMIT','超过你设置或市场允许的最大杠杆。');
  ensure(notional<=market.maxNotional,'MARKET_LIMIT','超过市场最大单仓名义价值。');
  ensure(size<=BigInt(wallet.funds.availableBalance),'BALANCE','可用余额不足（已考虑服务端预留金额）。');
  ensure(BigInt(wallet.locked)+size<=amount(c.maxTotalMargin,'maxTotalMargin'),'TOTAL_MARGIN','超过你设置的账户总保证金上限。');
  ensure(c.allowExistingPositions || wallet.openPositions.length===0,'EXISTING_POSITIONS','账户已有持仓，当前配置不允许继续开仓。');
  const long=c.side==='long';
  ensure((long?market.longOi:market.shortOi)+notional<=(long?market.longCap:market.shortCap),'OI_CAP','超过市场方向持仓上限。');
  return { user:c.wallet.toLowerCase(), instrumentId:market.id, isLong:long, size,
    leverage:c.leverage, useDebt:false }; // 示例只用可用余额，不动用排队债权。
}
