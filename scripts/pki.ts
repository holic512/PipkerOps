import { initPki } from "../src/lib/pki";
console.log(
  initPki()
    ? "私有 CA 与 Gateway TLS 证书已创建，私钥仅保存在本地"
    : "PKI 已存在，未覆盖",
);
