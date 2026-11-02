import { configValues } from "../../src/lib/config";
const response = await fetch(
  `http://127.0.0.1:${configValues.GATEWAY_PORT ?? 9444}/health`,
  { signal: AbortSignal.timeout(3000) },
);
process.exitCode = response.ok ? 0 : 1;
