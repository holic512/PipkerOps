// Local Linux acceptance needs a SAN reachable from isolated Docker containers.
import forge from "node-forge";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pkiFiles } from "../src/lib/pki";
const files = pkiFiles();
const target = process.env.DEV_TLS_CERT ?? ".data/pki/server-linux.crt";
const keyTarget = process.env.DEV_TLS_KEY ?? ".data/pki/server-linux.key";
if (existsSync(target) || existsSync(keyTarget))
  throw new Error("Dev certificate already exists; refusing to overwrite");
const ca = forge.pki.certificateFromPem(readFileSync(files.ca, "utf8"));
const caKey = forge.pki.privateKeyFromPem(readFileSync(files.caKey, "utf8"));
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01" + randomBytes(16).toString("hex");
cert.validity.notBefore = new Date(Date.now() - 60000);
cert.validity.notAfter = new Date(Date.now() + 30 * 86400000);
cert.setSubject([{ name: "commonName", value: "PipkerOps Linux acceptance" }]);
cert.setIssuer(ca.subject.attributes);
cert.setExtensions([
  { name: "basicConstraints", cA: false },
  { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
  { name: "extKeyUsage", serverAuth: true },
  {
    name: "subjectAltName",
    altNames: [
      { type: 2, value: "localhost" },
      { type: 2, value: "host.docker.internal" },
      { type: 7, ip: "127.0.0.1" },
    ],
  },
]);
cert.sign(caKey, forge.md.sha256.create());
writeFileSync(target, forge.pki.certificateToPem(cert), {
  mode: 0o600,
  flag: "wx",
});
writeFileSync(keyTarget, forge.pki.privateKeyToPem(keys.privateKey), {
  mode: 0o600,
  flag: "wx",
});
console.log("Local Linux acceptance TLS certificate created");
