# Contributing

感谢你愿意改进 `dsh-model-router`。

## 提交流程

1. Fork 本仓库并创建分支：`feat/xxx` 或 `fix/xxx`；
2. 保持改动聚焦，一个 PR 只解决一件事；
3. 提交前自检：
   - 不包含任何真实 API Key、Token、Cookie；
   - 不包含个人绝对路径（`C:\Users\...`、`D:\...`），配置示例使用相对路径或 `<PLACEHOLDER>`；
   - 不提交 `.model-router/`、`*.jsonl`、`*.log` 等本地运行产物；
   - `node --input-type=module -e "import('./index.js')"` 可正常加载；
4. PR 描述里写清动机、行为变化和验证方式。

## 代码风格

- 纯 ESM，无运行时依赖；
- 偏向小而清晰的函数，新增行为请补一行 `trace` 字段，便于用户排查；
- 配置项遵循「有默认值、可省略、改配置不需要改代码」；
- 中文注释/提示可以保留，面向用户的新文案建议同时给英文。

## 安全问题

如果发现密钥泄露或注入类风险，请不要开公开 Issue，先通过仓库主页邮箱联系维护者。
