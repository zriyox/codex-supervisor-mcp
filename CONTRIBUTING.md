# 怎么参与

[English](CONTRIBUTING.en.md)

## 跑起来

```bash
npm ci
npm test            # fake-codex 回放，一分钟内，不需要 Codex 账号
npm run test:real   # 真 codex CLI，要本机登录过 codex
```

Node 22.13.0 以上。看板改动另跑 `npm run web:dev`。目录结构和每个文件管什么在 [AGENTS.md](AGENTS.md)。

## 改代码的规矩

- 一个改动一个提交，提交信息写为什么改，不写改了什么（diff 自己会说）。
- 改了行为就加用例。worker 侧的行为用 `src/test-fixtures/fake-codex.js` 加一个场景回放，别依赖真 Codex。
- 用例不能依赖本机：git 身份、`PATH`、网络、`/tmp` 可写都不能当前提。CI 的 Linux 和 Windows runner 没有 git 身份，0.7.0 就是这么挂的。
- 三个平台都要过。Windows 的坑集中在 `.cmd` shim、路径分隔符、没有信号，见 README「Windows」。
- 加工具或改入参，一起改：`skills/codex-supervisor/SKILL.md`、两份 README 的工具表和工具数。skill 随包发，改了 skill 也得发版才到用户手里。
- README 工具表每行两句以内，机制和坑写进 skill 或「已知限制」。

## 发版

CI 四个 job 全绿才发。顺序固定：

```bash
npm version <x.y.z> -m "codex-supervisor-mcp %s"
npm publish                                   # prepublishOnly 会构建看板并跑全量测试
git push origin main --tags
gh release create v<x.y.z> --notes "..."
```

发完在一台没装过的机器上 `npm i -g codex-supervisor-mcp@<x.y.z>` 装一遍，确认 postinstall 把 skill 和注册都做对。

## 提 issue

带上：平台、`node -v`、`codex --version`、`check_for_update` 的返回、能复现的最小步骤。worker 出问题附 `data/runs/<taskId>.jsonl` 的最后 20 行。
