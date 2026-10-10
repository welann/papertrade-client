// 协议事实，不是策略参数。来源见 README；前端升级后需要重新核对。
import { hashTypedData, keccak256, concatHex, toHex, parseSignature } from 'viem';
export const BASE = 'https://exchange.papertrade.xyz';
export const BUILD_PATH = '/assets/build-D2camecd.js';
export const BUILD = '89e62bec3f93';
export const DOMAIN = Object.freeze({
  name: 'String', // 注意：这是前端的真实 domain name，不要改成 Papertrade。
  version: '1', chainId: 999,
  verifyingContract: '0x6cd5661646289fb6e65ea5c032310fded797d0a2',
});
export const TYPES = {
  OpenPosition: [
    { name: 'user', type: 'address' }, { name: 'instrumentId', type: 'uint32' },
    { name: 'isLong', type: 'bool' }, { name: 'size', type: 'uint128' },
    { name: 'leverage', type: 'uint32' }, { name: 'useDebt', type: 'bool' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
  Close: [
    { name: 'user', type: 'address' }, { name: 'positionIds', type: 'uint256[]' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' },
  ],
};
export const actionName = action => action === 'open' ? 'openPosition' : 'closePositions';
export async function signOrder(account, action, message) {
  const primaryType = action === 'open' ? 'OpenPosition' : 'Close';
  const typed = { domain: DOMAIN, types: { [primaryType]: TYPES[primaryType] }, primaryType, message };
  const signature = await account.signTypedData(typed);
  const { r, s, yParity } = parseSignature(signature);
  const signed = Object.fromEntries(Object.entries(message).map(([key, value]) => [key,
    Array.isArray(value) ? value.map(String) : typeof value === 'bigint' || typeof value === 'number' ? String(value) : value,
  ]));
  Object.assign(signed, { v: String(27 + yParity), r, s });
  // 与网页相同的意图编号：tag 哈希 + EIP-712 digest + signer 地址。
  const intentId = keccak256(concatHex([
    keccak256(toHex('papertrade:intent-id:v2')), hashTypedData(typed), account.address.toLowerCase(),
  ]));
  return { intentId, body: { action: actionName(action), signed } };
}
