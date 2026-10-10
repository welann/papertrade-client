// 所有需要你决定的参数集中在这里；金额必须写成字符串，避免浮点误差。
// 私钥不写在此文件：只把 SESSION KEY 放进 .session-key，权限设为 600。
// 不要使用主钱包私钥！本项目不负责注册/更新会话授权。
export default {
  mode: 'dry-run',             // dry-run：预检，不签名、不提交；live：真实提交一笔。
  wallet: '',                 // 你的主钱包地址（不是 Session Key 地址）。
  sessionKeyFile: '.session-key',

  // 同一逻辑订单始终使用相同 requestId。重复执行不会再次下单。
  // 只有你确实要发起另一笔独立订单时，才更换此值。
  requestId: 'my-first-order-001',
  action: 'open',             // open：开仓；close：按 positionIds 整仓平仓。
  symbol: 'BTC',              // 当前部署支持 BTC、ETH；开仓时使用。
  side: 'long',               // long 或 short；开仓时使用。
  margin: null,               // 必填，例如 "10"，表示保证金 USDC，不是名义价值。
  leverage: null,             // 必填整数；不会替你选择或自动提高杠杆。
  positionIds: [],            // 平仓必填，例如 ["123"]，每次最多 12 个。

  // 自己设定的开仓限制。不会因为交易所最低额度更高就自动加仓。
  maxMargin: null,            // 单笔保证金上限，字符串。
  maxNotional: null,          // 单笔名义价值上限，字符串；名义价值 = margin × leverage。
  maxTotalMargin: null,       // 账户已锁定保证金 + 本次保证金的上限，字符串。
  maxLeverage: null,          // 自己允许的最大杠杆，整数。
  allowExistingPositions: false,

  deadlineSeconds: 300,       // 签名有效期；不是撤单保证，已成交订单不会因此撤回。
  sessionSafetySeconds: 60,  // 会话有效期必须覆盖 deadline + 此余量。
  requestTimeoutMs: 15000,
  confirmationTimeoutMs: 60000,
  maxIndexAgeSeconds: 120,    // 状态索引落后太多时停止；电脑时钟应自动同步。
  stateDirectory: '.state',  // nonce、进程锁、订单记录。实盘后不要随意删除。
};
