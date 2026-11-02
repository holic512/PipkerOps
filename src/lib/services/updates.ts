/**
 * @file updates.ts
 * @project PipkerOps
 * @module managed-updates
 * @description GitHub 发布发现、制品校验分发和持久更新任务对账。
 * @logic 管理员显式发起；Worker 备齐制品再创建宿主任务；Ops 重启后按子任务结果对账。
 * @dependencies GitHub Releases, filesystem, Prisma, Agent HTTPS, task journal
 * @index_tags updates, releases, distribution, recovery
 * @author holic512
 */
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { configValues } from "../config";
import { db } from "../db";
import {
  ApiError,
  authorize,
  confirm,
  refreshActor,
  type Actor,
} from "../auth";
import { agentRequest, readCredential, testAgent } from "../agent-connection";
import { methodSchemas } from "./contracts";
import { createTask } from "./tasks";
import { finishTask } from "./results";
import { createBackup } from "../backup-storage";
import { registerDeployment } from "./nodes";
const api = "https://api.github.com/repos/holic512/PipkerOps/releases";
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const manifestSchema = z.object({
  format: z.literal(1),
  versions: z.object({ ops: version, agent: version, scripts: version }),
  assets: z.record(
    z.string(),
    z.object({
      name: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
type Release = {
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
};
export function trustedDownloadUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ![
      "api.github.com",
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(url.hostname)
  )
    throw new ApiError(502, "发布文件地址不受信任");
  return url;
}
async function download(raw: string, limit: number): Promise<Buffer> {
  let url = trustedDownloadUrl(raw);
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(120000),
      headers: {
        "User-Agent": "PipkerOps",
        Accept: "application/vnd.github+json",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = trustedDownloadUrl(
        new URL(response.headers.get("location") ?? "", url).href,
      );
      continue;
    }
    if (!response.ok || !response.body)
      throw new ApiError(502, `获取发布文件失败（HTTP ${response.status}）`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) {
        throw new ApiError(502, "发布文件超过大小限制");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new ApiError(502, "发布下载重定向过多");
}
async function release(tag: string) {
  const value = JSON.parse(
    (
      await download(`${api}/tags/${encodeURIComponent(tag)}`, 2 << 20)
    ).toString(),
  ) as Release;
  if (value.draft || value.prerelease || value.tag_name !== tag)
    throw new ApiError(400, "请选择正式发布版本");
  const asset = value.assets.find((a) => a.name === "release-manifest.json");
  if (!asset) throw new ApiError(400, "此发布没有新版更新清单，不支持自动更新");
  return {
    release: value,
    manifest: manifestSchema.parse(
      JSON.parse(
        (await download(asset.browser_download_url, 65536)).toString(),
      ),
    ),
  };
}
export async function listReleases(actor: Actor) {
  authorize(actor, "nodes:approve");
  const releases = JSON.parse(
    (await download(`${api}?per_page=30`, 2 << 20)).toString(),
  ) as Release[];
  return releases
    .filter(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        r.assets.some((a) => a.name === "release-manifest.json"),
    )
    .map((r) => ({ tag: r.tag_name, name: r.name }));
}
export async function queueUpdate(actor: Actor, input: unknown) {
  const data = methodSchemas["updates.create"].parse(input);
  authorize(actor, "nodes:approve", data.nodeId, true);
  if (data.component === "ops")
    authorize(actor, "admin:write", undefined, true);
  confirm(data.confirmed);
  await registerDeployment(actor, {
    nodeId: data.nodeId,
    deployRoot: data.deployRoot,
    component: data.component,
    confirmed: true,
  });
  return createTask(actor, {
    type: "platform.update",
    payload: {
      nodeId: data.nodeId,
      component: data.component,
      releaseTag: data.releaseTag,
      deployRoot: data.deployRoot,
    },
    confirmed: true,
    idempotencyKey: data.idempotencyKey,
  });
}
async function prepareArtifact(
  tag: string,
  key: string,
  releaseInfo?: Awaited<ReturnType<typeof release>>,
) {
  const info = releaseInfo ?? (await release(tag));
  const asset = info.manifest.assets[key];
  if (!asset) throw new ApiError(400, "发布清单缺少目标架构制品");
  const directory = configValues.RELEASE_CACHE_DIR ?? "./.data/releases";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(/* turbopackIgnore: true */ directory, asset.sha256);
  let content: Buffer | null = await readFile(
    /* turbopackIgnore: true */ path,
  ).catch(() => null);
  if (
    !content ||
    createHash("sha256").update(content).digest("hex") !== asset.sha256
  ) {
    const url = info.release.assets.find(
      (a) => a.name === asset.name,
    )?.browser_download_url;
    if (!url) throw new ApiError(502, "发布制品缺失");
    content = await download(url, 128 << 20);
    if (createHash("sha256").update(content).digest("hex") !== asset.sha256)
      throw new ApiError(502, "发布制品 SHA-256 校验失败");
    const temporary = `${path}.partial`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { ...asset, path, versions: info.manifest.versions };
}
export async function processUpdateQueue() {
  const claimed = await db().$queryRaw<
    { id: string }[]
  >`UPDATE "Task" SET status='RUNNING', attempts=attempts+1, "startedAt"=now(), "leaseExpiresAt"=now()+interval '30 minutes', "updatedAt"=now() WHERE id IN (SELECT id FROM "Task" WHERE type='platform.update' AND status='QUEUED' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id`;
  for (const { id } of claimed) {
    try {
      const task = await db().task.findUniqueOrThrow({ where: { id } });
      const p = task.payload as {
        nodeId: string;
        component: "agent" | "ops" | "scripts";
        releaseTag: string;
        deployRoot: string;
      };
      const actor = await refreshActor({
        userId: task.actorId!,
        role: "VIEWER",
        apiKeyId: task.apiKeyId ?? undefined,
      });
      authorize(actor, "nodes:approve", p.nodeId, true);
      if (p.component === "ops")
        authorize(actor, "admin:write", undefined, true);
      const node = await db().node.findUniqueOrThrow({
        where: { id: p.nodeId },
      });
      if (
        node.status !== "APPROVED" ||
        !node.agentUrl ||
        !node.agentCredentialRef ||
        !node.agentCaPem ||
        !node.agentId
      )
        throw new ApiError(409, "节点尚未接入或已停用");
      const bundle = {
        url: node.agentUrl,
        caPem: node.agentCaPem,
        accessKey: await readCredential(node.agentCredentialRef),
        agentId: node.agentId,
        format: 1 as const,
        protocolVersion: 1 as const,
        deployRoot: node.deployRoot ?? "",
      };
      const info = await testAgent(bundle);
      await registerDeployment(actor, {
        nodeId: p.nodeId,
        deployRoot: p.deployRoot,
        component: p.component,
        confirmed: true,
      });
      const releaseInfo = await release(p.releaseTag);
      if (
        p.component === "agent" &&
        info.agentVersion === releaseInfo.manifest.versions.agent
      ) {
        await finishTask(id, null, {
          success: true,
          output: "Agent 已是目标版本，无需更新",
          result: { expectedVersion: info.agentVersion },
        });
        continue;
      }
      const artifact = await prepareArtifact(
        p.releaseTag,
        p.component === "agent" ? `agent-${info.arch}` : "scripts",
        releaseInfo,
      );
      if (p.component !== "ops")
        await agentRequest(
          bundle,
          `/v1/artifacts/${artifact.sha256}`,
          artifact.path,
        );
      else await createBackup(id);
      await db().$transaction(async (tx) => {
        const child = await createTask(
          actor,
          {
            type:
              p.component === "agent"
                ? "agent.upgrade"
                : p.component === "ops"
                  ? "ops.update"
                  : "deployment.update",
            nodeId: node.id,
            payload:
              p.component === "ops"
                ? { deployRoot: p.deployRoot, version: artifact.versions.ops }
                : {
                    artifactId: artifact.sha256,
                    sha256: artifact.sha256,
                    ...(p.component === "agent"
                      ? { restart: true }
                      : { deployRoot: p.deployRoot }),
                  },
            confirmed: true,
            idempotencyKey: `${id}:execute`,
          },
          "SYSTEM",
          tx,
        );
        await tx.task.update({
          where: { id },
          data: {
            result: {
              executionTaskId: child.id,
              expectedVersion: artifact.versions[p.component],
            },
            output: `发布文件已校验，执行任务 ${child.id}`,
          },
        });
        await tx.node.update({
          where: { id: node.id },
          data: { deployRoot: p.deployRoot },
        });
      });
    } catch (error) {
      await finishTask(id, null, {
        success: false,
        error:
          error instanceof ApiError
            ? error.message
            : "更新准备失败，请检查发布清单、连接和备份",
        result: {},
      });
    }
  }
  const parents = await db().task.findMany({
    where: { type: "platform.update", status: { in: ["RUNNING", "UNKNOWN"] } },
    take: 50,
  });
  for (const parent of parents) {
    const result = (parent.result ?? {}) as {
      executionTaskId?: string;
      expectedVersion?: string;
    };
    if (!result.executionTaskId) {
      if (parent.status === "UNKNOWN")
        await finishTask(parent.id, null, {
          success: false,
          error:
            "更新准备阶段已中断，尚未创建宿主执行任务；检查备份及缓存后可重新发起",
          result: {},
        });
      continue;
    }
    const child = await db().task.findUnique({
      where: { id: result.executionTaskId },
    });
    if (
      !child ||
      !["SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"].includes(child.status)
    )
      continue;
    const p = parent.payload as { component: string };
    if (child.status === "SUCCEEDED" && p.component === "agent") {
      const node = await db().node.findUnique({ where: { id: child.nodeId! } });
      if (
        node?.agentVersion !== result.expectedVersion &&
        Date.now() - child.updatedAt.getTime() < 120000
      )
        continue;
      if (node?.agentVersion !== result.expectedVersion) {
        await finishTask(parent.id, null, {
          success: false,
          error:
            "文件已安装，但未确认 Agent 以目标版本重新连接，请检查 systemd 状态",
          result,
        });
        continue;
      }
    }
    await finishTask(parent.id, null, {
      success: child.status === "SUCCEEDED",
      error:
        child.error ??
        (child.status === "SUCCEEDED" ? undefined : "执行结果待检查"),
      output: child.output ?? "",
      result: {
        ...result,
        status: child.status === "UNKNOWN" ? "UNKNOWN" : child.status,
      },
    });
  }
}
