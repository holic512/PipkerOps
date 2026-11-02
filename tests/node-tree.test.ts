import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNodeTree,
  folderAncestors,
  folderPath,
} from "../src/lib/node-tree";
import {
  methodSchemas,
  methodOutputSchemas,
  mutation,
} from "../src/lib/services/contracts";
import { z } from "zod";

const folders = [
  { id: "prod", name: "生产", parentId: null },
  { id: "zone", name: "华东", parentId: "prod" },
  { id: "empty", name: "预留", parentId: "prod" },
  { id: "test", name: "测试", parentId: null },
];
const nodes = [
  {
    id: "a",
    name: "node10",
    hostname: "api",
    folderId: "zone",
    labels: ["web", "critical"],
    connected: true,
  },
  {
    id: "b",
    name: "node2",
    hostname: "db",
    folderId: "zone",
    labels: ["web"],
    connected: false,
  },
  {
    id: "c",
    name: "root",
    hostname: null,
    folderId: null,
    labels: [],
    connected: false,
  },
];

test("文件夹树保留空目录和根节点，递归计数并按名称自然排序", () => {
  const tree = buildNodeTree(nodes, folders);
  const prod = tree.folders.find((branch) => branch.folder.id === "prod")!;
  assert.deepEqual([prod.total, prod.online], [2, 1]);
  assert.deepEqual(
    prod.children
      .find((child) => child.folder.id === "zone")!
      .nodes.map((node) => node.id),
    ["b", "a"],
  );
  assert.ok(prod.children.some((child) => child.folder.id === "empty"));
  assert.deepEqual(
    tree.nodes.map((node) => node.id),
    ["c"],
  );
  assert.deepEqual([...folderAncestors("zone", folders)], ["zone", "prod"]);
  assert.equal(folderPath("zone", folders), "生产 / 华东");
});

test("搜索节点、主机、标签及父路径；多标签筛选保留祖先且采用交集", () => {
  for (const query of ["node10", "api", "critical", "华东", "生产"])
    assert.ok(
      buildNodeTree(nodes, folders, query).matched.some(
        (node) => node.id === "a",
      ),
    );
  const tree = buildNodeTree(nodes, folders, "", ["web", "critical"]);
  assert.deepEqual(
    tree.matched.map((node) => node.id),
    ["a"],
  );
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].children.length, 1);
  assert.equal(tree.folders[0].children[0].folder.id, "zone");
  assert.equal(tree.searching, true);
  assert.equal(
    buildNodeTree(nodes, folders, "预留").folders[0].children[0].folder.id,
    "empty",
  );
  assert.equal(
    buildNodeTree(nodes, folders, "预留", ["web"]).folders.length,
    0,
  );
  assert.equal(buildNodeTree(nodes, folders, "missing").matched.length, 0);
  assert.equal(buildNodeTree([], []).folders.length, 0);
});

test("分类契约公开可空归属与标签；原节点更新省略归属时不产生默认清空", () => {
  const update = methodSchemas["nodes.update"].parse({
    id: "a",
    name: "node",
    labels: [" web "],
  });
  assert.deepEqual(update.labels, ["web"]);
  assert.equal(update.folderId, undefined);
  assert.equal(
    methodSchemas["nodes.move"].safeParse({ nodeIds: [], folderId: null })
      .success,
    false,
  );
  assert.equal(
    methodSchemas["nodes.move"].safeParse({ nodeIds: ["a"], folderId: "" })
      .success,
    false,
  );
  assert.equal(
    methodSchemas["nodes.update"].safeParse({
      id: "a",
      name: "node",
      labels: [" "],
    }).success,
    false,
  );
  assert.equal(
    methodSchemas["nodes.update"].safeParse({
      id: "a",
      name: "node",
      labels: Array(51).fill("x"),
    }).success,
    false,
  );
  assert.equal(
    methodSchemas["nodes.update"].safeParse({
      id: "a",
      name: "node",
      labels: ["x".repeat(121)],
    }).success,
    false,
  );
  for (const method of [
    "nodes.move",
    "nodeFolders.list",
    "nodeFolders.save",
    "nodeFolders.delete",
  ] as const)
    assert.doesNotThrow(() => z.toJSONSchema(methodSchemas[method]));
  assert.equal(mutation("nodeFolders.list"), false);
  assert.equal(mutation("nodeFolders.save"), true);
  assert.ok(
    JSON.stringify(z.toJSONSchema(methodOutputSchemas["nodes.list"]!)).includes(
      '"folderId"',
    ),
  );
});
