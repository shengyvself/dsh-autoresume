window.__ModuleLoader__.load({ id: "dsh-autoresume", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
// dsh-autoresume 浏览器端为无界面占位：全部逻辑在服务端入口。
// 保留 client 入口是为了与 dsh.client 声明一致（package.json exports["./client"]）。
const name = 'dsh-autoresume/client';

function apply() {
  if (typeof console !== 'undefined') console.debug('[dsh-autoresume] client no-op');
}
module.exports = { name, apply };

return module.exports; } });
