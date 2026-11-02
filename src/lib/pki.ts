import { configValues } from "./config";
/**
 * @file pki.ts
 * @project PipkerOps
 * @module development-tls-fixture
 * @description 仅生成本地开发 HTTPS 夹具证书，不参与 Agent 接入。
 * @logic 明确命令创建开发 CA 和服务证书；已有文件不覆盖。
 * @dependencies node-forge, filesystem
 * @index_tags development, tls, fixture
 * @author holic512
 */
import forge from "node-forge";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const pkiDir = () => configValues.DEV_PKI_DIR ?? "./.data/pki";
export function pkiFiles() {
  const dir = pkiDir();
  return {
    ca: join(dir, "ca.crt"),
    caKey: join(dir, "ca.key"),
    cert: join(dir, "server.crt"),
    key: join(dir, "server.key"),
  };
}
export function initPki() {
  const files = pkiFiles();
  if (Object.values(files).some(existsSync)) {
    if (!Object.values(files).every(existsSync))
      throw new Error("PKI 不完整，拒绝覆盖");
    return false;
  }
  mkdirSync(pkiDir(), { recursive: true, mode: 0o700 });
  const caKeys = forge.pki.rsa.generateKeyPair(3072);
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = "01" + randomBytes(16).toString("hex");
  ca.validity.notBefore = new Date(Date.now() - 60000);
  ca.validity.notAfter = new Date(Date.now() + 3650 * 86400000);
  ca.setSubject([{ name: "commonName", value: "PipkerOps development CA" }]);
  ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01" + randomBytes(16).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  cert.setSubject([
    { name: "commonName", value: "PipkerOps development HTTPS" },
  ]);
  cert.setIssuer(ca.subject.attributes);
  const hosts = (configValues.DEV_TLS_HOSTS ?? "localhost,127.0.0.1")
    .split(",")
    .map((v) => v.trim());
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: hosts.map((host) =>
        /^\d+\.\d+\.\d+\.\d+$/.test(host)
          ? { type: 7, ip: host }
          : { type: 2, value: host },
      ),
    },
  ]);
  cert.sign(caKeys.privateKey, forge.md.sha256.create());
  for (const [path, value] of [
    [files.ca, forge.pki.certificateToPem(ca)],
    [files.caKey, forge.pki.privateKeyToPem(caKeys.privateKey)],
    [files.cert, forge.pki.certificateToPem(cert)],
    [files.key, forge.pki.privateKeyToPem(keys.privateKey)],
  ])
    writeFileSync(path, value, { mode: 0o600, flag: "wx" });
  return true;
}
