import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/crypto";
import { required } from "../src/lib/config";
const email = required("BOOTSTRAP_EMAIL").toLowerCase();
const password = required("BOOTSTRAP_PASSWORD");
if (password.length < 16 || password.includes("CHANGE_ME"))
  throw new Error("请设置至少16位随机管理员密码");
try {
  const existing = await db().user.findUnique({ where: { email } });
  if (existing) console.log("管理员已存在，未重置密码或权限");
  else {
    await db().user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        displayName: process.env.BOOTSTRAP_NAME ?? "管理员",
        role: "ADMIN",
      },
    });
    console.log("初始管理员已创建；密码仅位于本地环境配置");
  }
} finally {
  await db().$disconnect();
}
