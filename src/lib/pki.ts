/**
 * @file pki.ts
 * @project PipkerOps
 * @module agent-security
 * @description 为审批节点签发客户端证书，校验 CSR，维护本地 CA 与服务证书。
 * @logic CA 私钥不离开 Gateway；客户端证书绑定节点 ID，证书链与数据库状态双重校验。
 * @dependencies node-forge, filesystem
 * @index_tags tls, mtls, enrollment
 * @author holic512
 */
import forge from "node-forge";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { pkiDir } from "./config";
export function pkiFiles() {
  const dir = pkiDir();
  return {
    ca: join(dir, "ca.crt"),
    caKey: join(dir, "ca.key"),
    cert: join(dir, "server.crt"),
    key: join(dir, "server.key"),
  };
}
export function validateCsr(pem: string) {
  const csr = forge.pki.certificationRequestFromPem(pem);
  if (!csr.publicKey || !csr.verify()) throw new Error("CSR签名无效");
  const key = csr.publicKey as forge.pki.rsa.PublicKey;
  if (!key.n || key.n.bitLength() < 2048) throw new Error("RSA密钥至少2048位");
  return csr;
}
export function issueCertificate(nodeId: string, csrPem: string) {
  const csr = validateCsr(csrPem);
  const files = pkiFiles();
  const ca = forge.pki.certificateFromPem(
    readFileSync(/* turbopackIgnore: true */ files.ca, "utf8"),
  );
  const caKey = forge.pki.privateKeyFromPem(
    readFileSync(/* turbopackIgnore: true */ files.caKey, "utf8"),
  );
  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey!;
  cert.serialNumber = "01" + randomBytes(16).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60000);
  cert.validity.notAfter = new Date(Date.now() + 90 * 86400000);
  cert.setSubject([{ name: "commonName", value: nodeId }]);
  cert.setIssuer(ca.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    certificatePem: pem,
    certificateSerial: cert.serialNumber,
    certificateFingerprint: createHash("sha256")
      .update(Buffer.from(der, "binary"))
      .digest("hex"),
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
  ca.setSubject([{ name: "commonName", value: "PipkerOps private CA" }]);
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
  cert.setSubject([{ name: "commonName", value: "PipkerOps Gateway" }]);
  cert.setIssuer(ca.subject.attributes);
  const hosts = (process.env.PKI_HOSTS ?? "localhost,127.0.0.1")
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
