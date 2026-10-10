# Papertrade 单笔交易客户端

这是可运行的 Node.js 命令行项目，支持 **开仓**、**按持仓 ID 整仓平仓**、**只读预检**和**订单状态核对**。需要你已有的、已注册的 Session Key。它不创建钱包、不充值、不自动注册会话、不运行交易策略。

所有需要你决定的参数在 [config.mjs](config.mjs)。源码含中文注释。默认是 `dry-run`：预检通过也不签名、不发送订单。

## 1. 安装和第一次运行

要求 Node.js 22 或以上版本。macOS/Linux；密钥权限检查采用 POSIX 文件权限。

```bash
cd papertrade-client
npm ci
npm test
npm run inspect
```

`inspect` 不需要钱包地址或私钥，只读取公开市场状态。安装包里不含私钥、浏览器 cookie 或你的账户记录。

## 2. 在本机保存 Session Key

必须使用 **Session Key 私钥**，不能使用主钱包私钥或助记词。你的主钱包必须已在 Papertrade 授权这个会话。程序会从账户流核查会话地址、过期时间；拿到一个随机私钥不会自动得到交易权限。

推荐用下面的小段 Python，在终端隐藏输入，不把私钥写入 shell 历史或命令行参数；仅第一次创建，已有文件不会覆盖：

```bash
python3 - <<'PY'
import getpass, os, re
key = getpass.getpass('粘贴 Session Key（输入不可见）: ').strip()
if not re.fullmatch(r'0x[0-9a-fA-F]{64}', key):
    raise SystemExit('格式不正确，未写入')
fd = os.open('.session-key', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(key + '\n')
print('已保存到 .session-key，权限 600')
PY
```

文件是本地明文凭证，请仅保存在你控制的机器上；不上传网盘、代码仓库或聊天。保存后清空剪贴板。`.gitignore` 已忽略它，但这不等于加密。更换密钥前先处理旧订单的未知结果。

若页面显示 `Authenticate`，先由你在官方页面完成会话授权/解锁。网页的“已连接钱包”不等于你导出的 Session Key 一定仍获授权。

## 3. 集中填写参数

编辑 `config.mjs`：

| 参数 | 你需要决定什么 |
|---|---|
| `mode` | 先保持 `dry-run`；准备真实交易时由你改为 `live` |
| `wallet` | 主钱包地址，不是会话地址 |
| `sessionKeyFile` | 本地 Session Key 文件路径，默认 `.session-key` |
| `requestId` | 此逻辑订单的唯一编号；重启/网络超时后保持不变 |
| `action` | `open` 或 `close` |
| `symbol` / `side` | 开仓币种 BTC/ETH，方向 long/short |
| `margin` | 开仓保证金字符串，单位 USDC，如 `"10"`；不是名义价值 |
| `leverage` | 你选择的整数杠杆；程序不会自动提高 |
| `maxMargin` | 自己设置的单笔保证金上限 |
| `maxNotional` | 自己设置的单笔名义价值上限 |
| `maxTotalMargin` | 当前已锁定保证金加本次保证金的上限；不是亏损或总风险的保证 |
| `maxLeverage` | 自己允许的最大杠杆 |
| `allowExistingPositions` | 已有持仓时是否仍允许开仓，默认不允许 |
| `positionIds` | 平仓的具体持仓 ID 字符串，最多 12 个；不做模糊的“平掉最新仓位” |
| `deadlineSeconds` | 签名有效期 30–3600 秒，默认 300 |
| `sessionSafetySeconds` | 会话有效期额外余量，默认 60 秒 |
| `requestTimeoutMs` | 单次 GET/POST、首个账户快照等待时间 |
| `confirmationTimeoutMs` | 订单确认等待时间，默认 60 秒；不是到时自动撤单 |
| `maxIndexAgeSeconds` | 可接受的账户索引滞后；需保持系统时间准确 |
| `stateDirectory` | 持久化 nonce、进程锁和订单记录路径，默认 `.state` |

`margin`、`leverage` 和个人额度上限故意留空。程序会给出中文报错，不会替你选择交易规模。金额必须写成字符串；内部使用 BigInt 和 18 位协议精度。

运行：

```bash
npm start
```

在 `dry-run` 下，这会校验配置、前端 build 资源、账户状态、会话注册/有效期、操作暂停开关、余额、市场限额和你的额度上限。不会签名，不会分配 nonce，也不会 POST。

**2026-10-10 的只读验证结果**：公开接口返回最低保证金 10 USDC、最低开仓名义价值 10,000 USDC；开仓和平仓 intake 当时暂停。实时结果以 `npm run inspect` 为准。若你的额度设置达不到最低要求，程序停止，不会为了满足最低值而增加金额或杠杆。

## 4. 你自行运行真实交易

预检通过后，把配置改为 `mode: 'live'`，仔细确认方向、金额、杠杆、上限和 requestId，然后在你自己的终端运行：

```bash
npm start
```

**`live` 会直接发送真实订单，没有第二次交互确认。** 此命令仅由你自行执行；本项目交付时没有执行过真实交易。

程序依次执行：

1. 取得账户级本地进程锁，检查 requestId 是否已有记录。
2. 拒绝未解决的历史订单；同一 requestId 重跑只核对状态。
3. 读取市场状态和账户 SSE 流，完成预检。
4. 持久化分配 nonce，用会话私钥签 EIP-712。
5. 在 `.state` 写入签名请求和 intentId，完成 fsync，再发送唯一一次 POST。
6. 校验回执 intentId，随后从账户流确认结果。

`OpenPosition` 签名本身没有可填写的限价/最大滑点字段。本示例不伪造这些能力。预检通过也不能保证执行时的价格、余额、OI 或服务可用性没有变化；链上和服务端最终校验仍然生效。

平仓时设置 `action: 'close'` 并填写 `positionIds`，更换为新的 requestId。这是对指定持仓整仓平仓，最多 12 个，不支持部分减仓或自动拆批。开仓参数和个人开仓额度在平仓时不使用。

## 5. 超时、重启和订单核对

```bash
npm run status
```

使用配置中的 `wallet`、`requestId` 和 `.state` 记录，只读查询，不需要私钥。`succeeded` 表示收到了对应意图的成功结果，或者在持仓中找到了该开仓 intentId；`accepted` / `queued` 只表示受理/排队。

| 退出码 | 含义 |
|---|---|
| `0` | inspect/演练成功，或订单确认成功 |
| `1` | 配置、预检、网络或存储错误；先看中文提示 |
| `2` | 已明确失败、过期或取消 |
| `3` | **结果不确定**，不可盲目重下 |
| `130` | 收到中断信号并停止；若已有订单记录，仍需核对 |

无论服务端返回非 JSON、HTTP 错误、请求超时还是连接中断，POST 都不自动重试。服务端可能已经受理；客户端不能以“没收到回执”证明“没有订单”。原始错误响应也不会直接打印，以免回显签名内容。

当状态为 `unknown`：

- 保持原 requestId，运行 `npm run status`，同时检查官网的状态、历史及持仓。
- 不删除 `.state`，不更换 requestId 重试相同逻辑订单。
- 程序也会阻止同账户在旧订单未决时用新 requestId 创建新单。
- 若在断流期间已发生“开仓随后平仓/清算”，重连后的快照可能不再携带之前的成功事件。这种情况下本示例保留 `unknown`，不根据余额变化或订单消失猜测结果；需人工核对官网/链上历史后再处理本地记录。

进程正常退出会清除 `process.lock`。如果断电或被强制结束，锁可能残留：查看该锁内 PID，先确认原进程已退出，再只删除对应 `process.lock`。保留 nonce 和 `order-*.json`。残留锁不会自动超时抢占，避免双进程下单。

`.state` 中的签名请求在有效期内有授权效力，权限按 600 写入、目录按 700 创建。不要把运行后的 `.state` 发给别人。

## 6. 能力边界

- 这是单笔执行器，不是长期策略服务。没有自动续签、自动补单、自动撤单、重连后自动发新单或止损策略。
- 同一实例的 requestId 和进程锁保证本地幂等。多机器应共用真正的事务型存储；本示例不提供分布式锁。
- nonce 使用加密随机 128 位前缀加持久化计数，避免与网页的小整数序列碰撞；不是调用 EOA `getTransactionCount()`。仍不建议网页和多个脚本同时修改同一账户的仓位。
- 示例只使用可用余额，`useDebt=false`，不使用排队债权。
- 内部接口不承诺稳定。build 文件核对能发现该资源变化，但旧资源可能继续保留；不能据此保证整个站点从未升级。遇到 schema/build/认证错误会停止，不绕过防护、不自动套用新协议。
- 当前实现没有从浏览器复制 cookie，也没有导入主钱包凭证；若服务端以后要求额外鉴权，会明确失败。
- Node.js 22+ 可运行；测试实际运行环境为 Node.js 26。真实资金下单未测试。

## 7. 文件和验证

```text
config.mjs          需要你决定的参数
src/cli.mjs         单笔执行、演练、状态核对流程
src/protocol.mjs    EIP-712 类型、域、签名和 intentId
src/preflight.mjs   配置与下单前校验
src/state.mjs       SSE 解码、账户增量、市场状态解析
src/network.mjs     GET 重试、单次 POST、账户流
src/storage.mjs     私钥读取、锁、持久化 nonce、订单记录
test/client.test.mjs  合成密钥与模拟网络测试
```

已测试：签名地址恢复/大整数精度、平仓消息、暂停检查、会话过期、索引滞后、个人额度、SSE 分片和缺包、未知结果判断、单次 POST、持久化与进程锁、真实 CLI 演练零 POST、成功后重复运行零新增 POST、POST 超时后重复运行零新增 POST。

真实网络仅验证公开交易状态接口和测试地址的账户 SSE，不进行真实订单提交。请勿将测试通过理解为交易所保证受理或成交。

协议核对来源（2026-10-10）：

- https://exchange.papertrade.xyz/assets/index-Bawi_8Hu.js
- https://exchange.papertrade.xyz/assets/typed-data-B0hqt2-N.js
- https://exchange.papertrade.xyz/assets/deployment-C3VOxZVa.js
- https://exchange.papertrade.xyz/assets/account-wire-oK7wgoTe.js
- https://exchange.papertrade.xyz/assets/build-D2camecd.js
- https://exchange.papertrade.xyz/state/trading
