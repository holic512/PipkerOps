import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { dockerContainerSchema } from "../src/lib/docker-contracts";
import {
  locatorForContainer,
  matchResource,
} from "../src/lib/resource-discovery";
import { resourceMethodSchemas } from "../src/lib/resource-contracts";

const container = (
  id: string,
  name: string,
  labels: Record<string, string> = {},
) =>
  dockerContainerSchema.parse({
    id,
    name,
    image: "nginx:alpine",
    state: "running",
    status: "Up",
    ports: null,
    createdAt: null,
    labels,
  });

test("明确定位规则跨实例更新且不按镜像、相似名称或备用规则猜测", () => {
  const a = container("a", "api", {
    "pipkerops.resource-id": "deployment-stable-label",
  });
  const label = locatorForContainer("label", a);
  const b = container("b", "api", a.labels);
  assert.deepEqual(
    matchResource(label, [b]).instances.map((item) => item.id),
    ["b"],
  );
  const lost = container("b", "api");
  assert.equal(matchResource(label, [lost]).identification, "MISSING");
  assert.equal(
    matchResource(label, [b, container("c", "api-2", b.labels)]).identification,
    "CONFLICT",
  );
  assert.equal(
    matchResource(locatorForContainer("name", a), [container("b", "api-new")])
      .identification,
    "MISSING",
  );
});

test("Compose 资源按完整项目和服务标签匹配多个副本", () => {
  const labels = {
    "com.docker.compose.project": "site",
    "com.docker.compose.service": "api",
  };
  const a = container("a", "site-api-1", labels);
  const b = container("b", "site-api-2", labels);
  const other = container("c", "site-web-1", {
    ...labels,
    "com.docker.compose.service": "web",
  });
  const matched = matchResource(locatorForContainer("compose", a), [
    other,
    b,
    a,
  ]);
  assert.equal(matched.identification, "LOCATED");
  assert.equal(matched.runtimeState, "RUNNING");
  assert.deepEqual(
    matched.instances.map((item) => item.id),
    ["a", "b"],
  );
});

test("登记与重新指定必须明确确认，资源ID不接受容器名", () => {
  assert.equal(
    resourceMethodSchemas["resources.register"].safeParse({
      nodeId: "n",
      containerId: "a",
      name: "api",
      strategy: "name",
    }).success,
    false,
  );
  assert.equal(
    resourceMethodSchemas["resources.get"].safeParse({
      resourceId: "container-a",
    }).success,
    false,
  );
});

test("资源迁移保留部署、探针、历史操作和共享关联，仅合并确定相同的旧引用", async () => {
  const pg = new PGlite();
  try {
    const root = new URL("../prisma/migrations/", import.meta.url);
    const target = "202611040001_stable_resources";
    const names = (await readdir(root))
      .filter((name) => /^\d/.test(name))
      .sort();
    for (const name of names.filter((name) => name < target))
      await pg.exec(
        await readFile(new URL(`${name}/migration.sql`, root), "utf8"),
      );
    await pg.exec(`
      INSERT INTO "Node" (id,name,"updatedAt") VALUES ('n','node',now());
      INSERT INTO "Application" (id,name,"updatedAt") VALUES ('app-a','A',now()),('app-b','B',now());
      INSERT INTO "Deployment" (id,"applicationId","nodeId",name,type,target,"updatedAt") VALUES
      ('a','app-a','n','api','docker','container-a',now()),
      ('b','app-b','n','shared-api','docker','container-a',now()),
      ('c','app-a','n','unresolved','docker','container-other',now());
      INSERT INTO "Probe" (id,name,type,target,"applicationId","updatedAt") VALUES ('probe','health','HTTP','http://127.0.0.1','app-a',now());
      INSERT INTO "DockerOperation" (id,method,"nodeId",source,target,"idempotencyKey","requestHash","updatedAt") VALUES ('operation','docker.action','n','WEB','container-a','original','hash',now());
    `);
    await pg.exec(
      await readFile(new URL(`${target}/migration.sql`, root), "utf8"),
    );
    const resources = (
      await pg.query<{
        id: string;
        strategy: string;
        metadata: { legacyTarget: string };
      }>(
        "SELECT id,strategy,metadata FROM \"Resource\" ORDER BY metadata->>'legacyTarget'",
      )
    ).rows;
    assert.equal(resources.length, 2);
    assert.ok(
      resources.every(
        (resource) =>
          /^[a-f0-9-]{36}$/.test(resource.id) &&
          resource.strategy === "unconfirmed",
      ),
    );
    const links = (
      await pg.query<{ resourceId: string; applicationId: string }>(
        'SELECT "resourceId","applicationId" FROM "ApplicationResource" ORDER BY "applicationId"',
      )
    ).rows;
    assert.equal(links.length, 3);
    const shared = resources.find(
      (resource) => resource.metadata.legacyTarget === "container-a",
    )!;
    assert.equal(
      links.filter((link) => link.resourceId === shared.id).length,
      2,
    );
    assert.equal((await pg.query('SELECT * FROM "Probe"')).rows.length, 1);
    assert.equal(
      (
        await pg.query<{ target: string; resourceId: string | null }>(
          'SELECT target,"resourceId" FROM "DockerOperation"',
        )
      ).rows[0].target,
      "container-a",
    );
    await pg.exec("DELETE FROM \"Application\" WHERE id='app-a'");
    assert.equal((await pg.query('SELECT * FROM "Resource"')).rows.length, 2);
    assert.equal(
      (await pg.query('SELECT * FROM "ApplicationResource"')).rows.length,
      1,
    );
  } finally {
    await pg.close();
  }
});
