# 发布 / 分享打包指南

> 依据官方文档（`docs/user/develop/basic/publish.md` 等）与社区实践整理。

## 核心结论

**DSH 官方分发形态 = "带 `dsh.bundle` manifest 的 npm 组合包（bundle）+ `cordis.patch.yml`"**，
用户通过 `dsh plugin --profile <name> add <包>` 安装。

**动态 Cordis 插件（本会话用 `cordis_define` 创建的）没有官方导出通道**：
定义只存在于当前进程、不落盘、重启失效。分享需把代码人工落盘成插件模块文件，再走下面的标准打包流程。

---

## 0. 命名规范（多人发布不冲突）

> 依据 `dsh-app-boot` 的 patch 语义与 `cordis-plugin-loader` 的 id 去重机制（见 §6）。

- **包名**用 npm scope 隔离：`@<作者或组织>/dsh-token-usage`。scope 是发布者身份，npm 全局唯一。
- **插件行 id** 与包名保持一致（带 `@scope/` 前缀）。源码证据：`cordis-plugin-loader.update()`
  对两条相同 id 的行直接抛 `duplicate loader entry id`，导致启动失败——所以 id 必须带作者前缀避免撞车。
- 当前文件用占位 `@wycto/`，发布前替换成你的真实 npm scope/用户名。

---

## 1. 本地开发（体验插件）

```bash
# 项目根
scratch-plugin/
├── cordis.yml          # YAML patch 数组
└── src/my-plugin.ts    # export { name, apply(ctx) }（或对象/类）

# cordis.yml:
# - insert:
#     - id: token-usage
#       name: 'C:/abs/path/scratch-plugin/src/my-plugin.ts'   # 必须绝对路径

pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

## 2. 打包为可分发 bundle

```
@wycto/dsh-token-usage/           # npm 包(带 scope)
├── package.json
│   # {
│   #   "name": "@wycto/dsh-token-usage",
│   #   "publishConfig": { "access": "public" },
│   #   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
│   #   "main": "lib/index.js"
│   # }
├── cordis.patch.yml    # 插入插件行, name 用包名(非路径)
└── lib/index.js        # 编译产物(host 逻辑)
```

要点：
- patch 行 `name` 必须等于包名（client 名册按包名解析）。
- 有浏览器界面时 package.json 再声明 `dsh.client: { platform: 'web' }` + `exports["./client"]`（tsdown 打包的 CJS closure-factory）；host 用 `ctx.clientModules` 注入。
- 对 `@deepseek-ai/*` 的依赖用 **peerDependencies**（运行时从 profile 的 node_modules 解析）。
- **包内依赖**：host 侧若只用内建服务（`ctx.tools`、`ctx.session`、`session/event` 事件），可零依赖；本插件（token-usage）只用内建事件与 harness.handle，因此 bundle 无需额外运行时依赖。

## 3. 发布与安装

| 分发方式 | 作者操作 | 用户操作 |
|---|---|---|
| **npm** | `pnpm build && pnpm publish` | `dsh plugin --profile demo add @wycto/dsh-token-usage` |
| **tarball** | `pnpm pack` → `xxx.tgz` | `dsh plugin --profile demo add ./xxx.tgz` |
| **git** | push + 提供 `prepare` 脚本 | `dsh plugin --profile demo add github:you/repo#<sha>`（需在 profile 的 `pnpm-workspace.yaml` 对该包 `allowBuilds: true`） |

首次 add 会自动加入 `@deepseek-ai/dsh-base`；之后 `dsh --profile demo` 启动即可。

## 4. 本插件的具体落盘（把当前动态插件固化为静态模块）

把 `cordis_define` 里两份代码（host 逻辑 + client UI 逻辑）保存为：

```
@wycto/dsh-token-usage/
├── package.json          # name: @wycto/dsh-token-usage; dsh.bundle.patch
├── cordis.patch.yml      # - insert: - id: '@wycto/dsh-token-usage', name: '@wycto/dsh-token-usage'
├── lib/index.js          # Host: return { name, apply(ctx){ ... } }
└── client.js             # Client(web): 编译产物, package.json exports["./client"]
```

然后按第 2、3 节发布。用户安装后侧边栏出现"Token 用量"入口。

## 5. 关键来源

- 官方：[第一个插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) ｜ [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) ｜ [config](https://deepseek-harness.github.io/deepseek-harness/develop/basic/config) ｜ [client-modules 机制](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/client-modules.md)
- 社区实战：[NanmiCoder/dsh-agent-teams developing-dsh-plugins.md](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/docs/developing-dsh-plugins.md)
- 官方 RFC（脚手架，尚未发布）：[#1629](https://github.com/deepseek-ai/deepseek-harness/discussions/1629)

## 6. 命名冲突的源码依据

多人发布同名插件会怎样？三个层面逐级验证：

1. **npm 包名层**：包名全局唯一，同名会解析到同一包（后装覆盖/依赖冲突）→ 用 `@scope/` 隔离。
2. **patch 追加层**（`dsh-app-boot` `applyEntryPatches`）：`- insert:` 把行**追加**进组合列表；
   两个插件的 patch 各自追加 → 列表里可能出现两条相同 `id` 的行。
3. **loader 去重层**（`cordis-plugin-loader` `update()`）：
   ```js
   for (const options of config) {
     const id = this.tree.ensureId(options);
     if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`);
     seen.add(id);
   }
   ```
   **两条相同 id 的行 → 抛 `duplicate loader entry id` → DSH 启动失败**。

因此发布插件必须：**包名 + 插件行 id 都带 `@scope/` 作者前缀**（id 直接等于包名即可），
即使用户装了多个同功能插件也能共存。注意：只有行**未写 id** 时 loader 才随机分配 id，
所以"都不写 id"虽然不冲突，但违背 patch 规范，且无法被用户精确禁用/配置——不推荐。