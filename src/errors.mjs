export class ClientError extends Error {
  constructor(code, message) { super(message); this.name = 'ClientError'; this.code = code; }
}
export function ensure(condition, code, message) {
  if (!condition) throw new ClientError(code, message);
}
// 不输出任意异常堆栈、请求体或环境变量：库异常有可能包含签名参数。
export function safeMessage(error) {
  return error instanceof ClientError ? `[${error.code}] ${error.message}` :
    '发生未预期错误；已停止。不会自动重试 POST。请检查配置和本地订单记录。';
}
