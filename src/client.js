// dsh-autoresume 浏览器端为无界面占位：全部逻辑在服务端入口。
// 保留 client 入口是为了与 dsh.client 声明一致（package.json exports["./client"]）。
export const name = 'dsh-autoresume/client';

export function apply() {
  if (typeof console !== 'undefined') console.debug('[dsh-autoresume] client no-op');
}
