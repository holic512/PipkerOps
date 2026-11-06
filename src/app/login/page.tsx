import { Login } from "@/components/login";
import { httpsRequired } from "@/lib/config";
import { connection } from "next/server";

// 运行时读取服务端配置，避免将开关固化在构建产物中。
export default async function LoginPage() {
  await connection();
  return <Login requireHttps={httpsRequired()} />;
}
