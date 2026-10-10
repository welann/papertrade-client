import { ensure, ClientError } from './errors.mjs';
export const uint = v => typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v);
const hash = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
function shape(ok) { ensure(ok, 'SCHEMA_CHANGED', '服务端字段格式不符合已核对版本，停止执行。'); }

// 从公开 wire schema 还原交易状态。遇到未知布局时拒绝猜测。
export function tradingState(raw) {
  shape(raw?.schemaVersion === 1 && typeof raw.tradingPaused === 'boolean');
  shape(uint(raw.minimumTradeSizeRaw) && uint(raw.minimumOpenNotionalRaw));
  shape(Array.isArray(raw.intake) && raw.intake.length === 4 && Array.isArray(raw.intake[3]));
  shape(raw.intake[3].every(x => typeof x === 'string') && uint(raw.intake[2]));
  shape(Array.isArray(raw.instruments));
  const markets = raw.instruments.map(row => {
    shape(Array.isArray(row) && row.length === 23);
    shape(Number.isSafeInteger(row[0]) && typeof row[1] === 'string');
    shape([4,5,6,7,8].every(i => typeof row[i] === 'boolean'));
    shape(Number.isSafeInteger(row[14]) && row[14] > 0);
    shape([15,19,20,21,22].every(i => uint(row[i])));
    return { id: row[0], symbol: row[1], openable: row[4] && !row[5],
      maxLeverage: row[14], maxNotional: BigInt(row[15]),
      longOi: BigInt(row[19]), shortOi: BigInt(row[20]),
      longCap: BigInt(row[21]), shortCap: BigInt(row[22]) };
  });
  shape(new Set(markets.map(m=>m.id)).size === markets.length);
  return { paused: raw.tradingPaused, disabledActions: raw.intake[3], markets,
    minMargin: BigInt(raw.minimumTradeSizeRaw), minNotional: BigInt(raw.minimumOpenNotionalRaw),
    maxNetOi: BigInt(raw.intake[2]) };
}

// SSE 首包为完整快照，后续为带 baseAccountRevision 的增量。
// 必须连续应用；缺包就抛错重连，不能拿旧余额继续交易。
export function applyWallet(previous, frame, wallet) {
  shape(frame && typeof frame === 'object' && frame.address === wallet);
  shape(Number.isSafeInteger(frame.accountRevision) && frame.accountRevision > 0);
  let next;
  if (Object.hasOwn(frame, 'baseAccountRevision')) {
    ensure(previous && frame.baseAccountRevision === previous.accountRevision,
      'STREAM_GAP', '账户增量不连续，需要重新读取完整快照。');
    shape(frame.accountRevision > previous.accountRevision);
    shape(frame.state && typeof frame.state === 'object');
    next = { ...previous, ...frame.state, accountRevision: frame.accountRevision,
      openPositions: mergeRows(previous.openPositions, frame.addedPositions, frame.removedPositionIds),
      operations: mergeRows(previous.operations, frame.addedOperations, frame.removedOperationIds),
      intentOutcomes: frame.intentOutcomes ?? [] };
  } else {
    next = { ...frame, intentOutcomes: frame.intentOutcomes ?? [] };
  }
  shape(Number.isSafeInteger(next.indexedThroughTimestamp) && next.indexedThroughTimestamp >= 0);
  shape(uint(next.locked) && uint(next.balance) && uint(next.queueRevision));
  shape(next.funds && ['availableBalance','reservedBalance','availableQueued','reservedQueued'].every(k=>uint(next.funds[k])));
  shape(Array.isArray(next.sessionKeys) && next.sessionKeys.every(r=>Array.isArray(r) && r.length===2 && /^0x[0-9a-f]{40}$/.test(r[0]) && uint(r[1])));
  shape(Array.isArray(next.openPositions) && next.openPositions.every(r=>Array.isArray(r) && r.length===10 && uint(r[0]) && uint(r[5]) && (r[9]===null || hash(r[9]))));
  shape(Array.isArray(next.operations) && next.operations.every(r=>Array.isArray(r) && r.length===10 && hash(r[0])));
  shape(Array.isArray(next.intentOutcomes) && next.intentOutcomes.every(r=>Array.isArray(r) && r.length===2 && hash(r[0]) && ['succeeded','failed','expired','cancelled','unknown'].includes(r[1])));
  const available = BigInt(next.balance) > BigInt(next.funds.reservedBalance) ? BigInt(next.balance)-BigInt(next.funds.reservedBalance) : 0n;
  shape(available === BigInt(next.funds.availableBalance));
  return next;
}
function mergeRows(rows, added, removed) {
  shape(Array.isArray(added) && Array.isArray(removed));
  const map = new Map(rows.map(r=>[String(r[0]),r]));
  for (const id of removed) { shape(map.has(String(id))); map.delete(String(id)); }
  for (const row of added) { shape(Array.isArray(row) && !map.has(String(row[0]))); map.set(String(row[0]),row); }
  return [...map.values()];
}
export function outcomeFor(state, intentId) {
  const terminal = state.intentOutcomes.find(r=>r[0]===intentId);
  if (terminal && terminal[1] !== 'unknown') return terminal[1];
  // 开仓持仓上的 intentId 是归属证据；不凭余额变化推断成交。
  if (state.openPositions.some(r=>r[9]===intentId)) return 'succeeded';
  if (state.operations.some(r=>r[0]===intentId)) return 'queued';
  return 'unknown';
}

// 流式 SSE 解码：支持跨 chunk UTF-8、CRLF、多行 data 和注释心跳。
export async function* sseEvents(body) {
  ensure(body, 'STREAM', '服务端没有返回 SSE 响应体。');
  const decoder = new TextDecoder();
  let buffer = '', data = [], event = 'message';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    ensure(buffer.length + data.join('').length < 4_000_000, 'STREAM_SIZE', '账户流消息过大。');
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0,at).replace(/\r$/, ''); buffer = buffer.slice(at+1);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        data = []; event = 'message';
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0,colon);
        let value = colon === -1 ? '' : line.slice(colon+1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
  // 未以空行终止的残包不分发，调用者会报告流结束。
}
