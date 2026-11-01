import { request } from "node:https";
import { readFileSync } from "node:fs";
import { pkiFiles } from "../src/lib/pki";
const req = request(
  {
    host: "127.0.0.1",
    port: 9444,
    path: "/health",
    ca: readFileSync(pkiFiles().ca),
    servername: (process.env.PKI_HOSTS ?? "localhost").split(",")[0].trim(),
    timeout: 3000,
  },
  (res) => {
    res.resume();
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  },
);
req.on("error", () => {
  process.exitCode = 1;
});
req.on("timeout", () => req.destroy());
req.end();
