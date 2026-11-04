/** Isolated PostgreSQL and a real TLS transport fixture; no configured business backend is used. */
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "../src/generated/prisma/client";
import { organizationFixture } from "./helpers/organization-fixture";
import { configValues } from "../src/lib/config";
import { initPki, pkiFiles } from "../src/lib/pki";
import { saveCredential } from "../src/lib/agent-connection";
import {
  executeResource,
  resolveResource,
} from "../src/lib/services/resources";
import {
  resourceMethodSchemas,
  type ResourceMethod,
} from "../src/lib/resource-contracts";
import {
  dockerContainerSchema,
  type DockerContainer,
} from "../src/lib/docker-contracts";
import { randomToken } from "../src/lib/crypto";
import { execute as executePlatform } from "../src/lib/services/platform";
import type { Actor } from "../src/lib/auth";

const container = (
  id: string,
  name: string,
  labels: Record<string, string> = {},
) =>
  dockerContainerSchema.parse({
    id,
    name,
    labels,
    image: "test-image",
    state: "running",
    status: "Up",
    ports: null,
    createdAt: null,
    exitCode: 0,
  });

test(
  "真实资源服务：A登记→两应用共享→B更新；失败、身份丢失、冲突和解除共享保留身份",
  { timeout: 120000 },
  async () => {
    const fixture = await organizationFixture();
    const originalConfig = { ...configValues };
    const globalDb = globalThis as unknown as { db?: PrismaClient };
    const previousDb = globalDb.db;
    globalDb.db = fixture.client;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      configValues.DEV_PKI_DIR = join(fixture.directory, "pki");
      configValues.NODE_CREDENTIALS_DIR = join(
        fixture.directory,
        "credentials",
      );
      configValues.DEV_TLS_HOSTS = "localhost,127.0.0.1";
      initPki();
      const files = pkiFiles();
      const accessKey = randomToken();
      const label = { "pipkerops.resource-id": "persisted-in-deployment" };
      let containers: DockerContainer[] = [
        container("container-a", "api", label),
      ];
      let incomplete = false;
      let collectionCount = 0;
      server = createServer(
        { key: await readFile(files.key), cert: await readFile(files.cert) },
        async (req, res) => {
          if (req.headers.authorization !== `Bearer ${accessKey}`) {
            res.writeHead(403).end();
            return;
          }
          let body = "";
          for await (const chunk of req) body += chunk;
          const { method, params } = JSON.parse(body) as {
            method: string;
            params: { id?: string };
          };
          res.setHeader("content-type", "application/json");
          if (method === "docker.list") {
            collectionCount++;
            res.end(JSON.stringify({ containers }));
          } else if (method === "docker.inspect") {
            const selected = containers.find((item) => item.id === params.id);
            if (incomplete || !selected)
              res
                .writeHead(500)
                .end(JSON.stringify({ error: "incomplete fixture" }));
            else
              res.end(
                JSON.stringify({
                  containers: [
                    {
                      Id: selected.id,
                      Name: "/" + selected.name,
                      Config: { Labels: selected.labels },
                      State: {
                        Status: selected.state,
                        ExitCode: selected.exitCode ?? 0,
                      },
                    },
                  ],
                }),
              );
          } else
            res
              .writeHead(400)
              .end(JSON.stringify({ error: "unexpected method" }));
        },
      );
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await saveCredential("resource-test", accessKey);
      const actor: Actor = { userId: "resource-user", role: "ADMIN" };
      await fixture.client.user.create({
        data: {
          id: actor.userId,
          email: "resource@test.invalid",
          passwordHash: "unused",
          displayName: "test",
          role: "ADMIN",
        },
      });
      await fixture.client.node.create({
        data: {
          id: "n",
          name: "test-node",
          status: "APPROVED",
          lastSeenAt: new Date(),
          agentUrl: `https://127.0.0.1:${address.port}`,
          agentCaPem: await readFile(files.ca, "utf8"),
          agentCredentialRef: "resource-test",
        },
      });
      for (const id of ["app-a", "app-b"])
        await fixture.client.application.create({ data: { id, name: id } });
      const execute = (
        method: ResourceMethod,
        params: Record<string, unknown>,
      ) =>
        executeResource(
          actor,
          method,
          resourceMethodSchemas[method].parse(params),
        );
      type Resource = Awaited<
        ReturnType<typeof fixture.client.resource.findUniqueOrThrow>
      >;
      const preview = (await execute("resources.preview", {
        nodeId: "n",
        containerId: "container-a",
        strategy: "label",
      })) as { duplicates: unknown[] };
      assert.equal(preview.duplicates.length, 0);
      await assert.rejects(
        execute("resources.register", {
          nodeId: "n",
          containerId: "container-a",
          name: "API",
          strategy: "label",
          confirmed: true,
        }),
        { status: 400 },
      );
      const resource = (await execute("resources.register", {
        nodeId: "n",
        containerId: "container-a",
        name: "API",
        strategy: "label",
        confirmed: true,
        persistenceConfirmed: true,
      })) as Resource;
      assert.match(resource.id, /^[a-f0-9-]{36}$/);
      assert.notEqual(resource.id, containers[0].id);
      assert.notEqual(resource.id, label["pipkerops.resource-id"]);
      for (const applicationId of ["app-a", "app-b"])
        await execute("resources.associate", {
          resourceId: resource.id,
          applicationId,
        });
      assert.equal(
        await fixture.client.applicationResource.count({
          where: { resourceId: resource.id },
        }),
        2,
      );
      await assert.rejects(
        execute("resources.register", {
          nodeId: "n",
          containerId: "container-a",
          name: "Duplicate via name",
          strategy: "name",
          confirmed: true,
        }),
        { status: 409 },
      );

      containers = [container("container-b", "api", label)];
      const changed = await resolveResource(actor, resource.id);
      assert.equal(changed.containerId, "container-b");
      assert.equal(changed.id, resource.id);
      assert.equal(changed.applications.length, 2);
      await assert.rejects(resolveResource(actor, resource.id, "container-a"), {
        status: 409,
      });

      incomplete = true;
      const stale = (await execute("resources.discover", {
        resourceId: resource.id,
      })) as Resource;
      assert.equal(stale.identification, "STALE");
      assert.equal((stale.instances as { id: string }[])[0].id, "container-b");
      assert.ok(stale.discoveryError);
      await assert.rejects(resolveResource(actor, resource.id), {
        status: 409,
      });
      incomplete = false;

      containers = [container("container-b", "api")];
      const missing = (await execute("resources.discover", {
        resourceId: resource.id,
      })) as Resource;
      assert.equal(missing.identification, "MISSING");
      assert.equal(missing.id, resource.id);
      assert.equal(
        await fixture.client.applicationResource.count({
          where: { resourceId: resource.id },
        }),
        2,
      );
      await assert.rejects(resolveResource(actor, resource.id), {
        status: 409,
      });

      containers = [
        container("container-b", "api", label),
        container("container-c", "api-replica", label),
      ];
      const conflict = (await execute("resources.discover", {
        resourceId: resource.id,
      })) as Resource;
      assert.equal(conflict.identification, "CONFLICT");
      await assert.rejects(resolveResource(actor, resource.id, "container-b"), {
        status: 409,
      });

      containers = [container("container-b", "api")];
      const rebound = (await execute("resources.rebind", {
        resourceId: resource.id,
        nodeId: "n",
        containerId: "container-b",
        strategy: "name",
        confirmed: true,
      })) as Resource;
      assert.equal(rebound.id, resource.id);
      assert.equal(rebound.strategy, "name");
      assert.equal(
        (await resolveResource(actor, resource.id)).containerId,
        "container-b",
      );
      await execute("resources.unlink", {
        resourceId: resource.id,
        applicationId: "app-a",
        confirmed: true,
      });
      assert.equal(await fixture.client.resource.count(), 1);
      assert.equal(
        await fixture.client.applicationResource.count({
          where: { resourceId: resource.id },
        }),
        1,
      );
      await fixture.client.application.delete({ where: { id: "app-a" } });
      assert.equal(
        await fixture.client.applicationResource.count({
          where: { resourceId: resource.id },
        }),
        1,
      );

      containers = [{ ...containers[0], state: "exited", exitCode: 3 }];
      const failed = (await execute("resources.discover", {
        resourceId: resource.id,
      })) as Resource;
      assert.equal(failed.runtimeState, "FAILED");
      assert.equal(failed.identification, "LOCATED");
      await fixture.client.node.update({
        where: { id: "n" },
        data: { lastSeenAt: new Date(Date.now() - 120000) },
      });
      assert.equal(
        (
          (await execute("resources.get", {
            resourceId: resource.id,
          })) as Resource
        ).identification,
        "STALE",
      );

      await fixture.client.node.update({
        where: { id: "n" },
        data: { lastSeenAt: new Date() },
      });
      await fixture.client.resource.update({
        where: { id: resource.id },
        data: { lastAttemptedAt: new Date(Date.now() - 120000) },
      });
      const beforeRefresh = collectionCount;
      await execute("resources.list", {});
      assert.equal(collectionCount, beforeRefresh + 1);
      await execute("resources.list", {});
      assert.equal(collectionCount, beforeRefresh + 1);

      const composeLabels = {
        "com.docker.compose.project": "site",
        "com.docker.compose.service": "web",
      };
      containers.push(
        container("replica-1", "site-web-1", composeLabels),
        container("replica-2", "site-web-2", composeLabels),
      );
      const compose = (await execute("resources.register", {
        nodeId: "n",
        containerId: "replica-1",
        name: "Web service",
        strategy: "compose",
        confirmed: true,
      })) as Resource;
      assert.equal((compose.instances as unknown[]).length, 2);
      await assert.rejects(resolveResource(actor, compose.id), { status: 409 });
      assert.equal(
        (await resolveResource(actor, compose.id, "replica-2")).containerId,
        "replica-2",
      );
      assert.ok(
        (await fixture.client.auditEvent.count({
          where: { resourceId: resource.id },
        })) >= 5,
      );
      await assert.rejects(
        executeResource(
          { userId: actor.userId, role: "VIEWER" },
          "resources.register",
          { nodeId: "n" },
        ),
        { status: 403 },
      );
      const restrictedApp = await fixture.client.application.create({
        data: { name: "restricted-resource-delete" },
      });
      const foreignNode = await fixture.client.node.create({
        data: { name: "foreign" },
      });
      const foreignResource = await fixture.client.resource.create({
        data: {
          id: randomUUID(),
          name: "foreign-resource",
          nodeId: foreignNode.id,
          type: "docker",
          strategy: "unconfirmed",
        },
      });
      await fixture.client.applicationResource.create({
        data: {
          resourceId: foreignResource.id,
          applicationId: restrictedApp.id,
        },
      });
      await assert.rejects(
        executePlatform(
          {
            ...actor,
            apiKeyId: "restricted-key",
            scopes: ["apps:write"],
            nodeIds: ["n"],
            allowDangerous: true,
          },
          "applications.delete",
          { id: restrictedApp.id, confirmed: true },
        ),
        { status: 403 },
      );
      assert.equal(
        await fixture.client.applicationResource.count({
          where: { applicationId: restrictedApp.id },
        }),
        1,
      );
    } finally {
      if (server)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      globalDb.db = previousDb;
      for (const key of Object.keys(configValues)) delete configValues[key];
      Object.assign(configValues, originalConfig);
      await fixture.close();
    }
  },
);
