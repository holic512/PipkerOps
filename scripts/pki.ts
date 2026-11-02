import { initPki } from "../src/lib/pki";
console.log(
  initPki()
    ? "本地开发 HTTPS 夹具的 CA 与证书已创建，不用于 Agent 接入"
    : "开发 TLS 证书已存在，未覆盖",
);
