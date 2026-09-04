# swarm-pi-code-plugin

[English](README.md)

Swarm Pi 是符合 [Agent Plugins 1.0](https://agent-plugins.org/specification) 的可攜
套件，並保留 Claude Code 與 Codex 原生 adapter。套件內十個 Agent Skills 將相容 client
連接到受邊界限制的 Pi Worker，可處理以 repository 為依據的提問、規劃、審查、Discovery、
設定、Scaffold 與已授權的實作。Host 保留意圖、核准、驗證與交付權；Pi 不擁有 commit、
merge、push、部署、訊息或交易權限。

## 快速開始

先從共用 marketplace 安裝，再從 Claude Code 或 Codex 開啟 Configuration。連接
Provider、選擇主要／fallback 模型、設定角色與專案範圍，最後儲存。

```bash
claude plugin marketplace add https://github.com/JiaWeiXie/swarm-pi-code-plugin
claude plugin install swarm-pi-code-plugin@swarm-pi-code-plugin
```

Codex 安裝方式：

```bash
codex plugin marketplace add https://github.com/JiaWeiXie/swarm-pi-code-plugin
codex plugin add swarm-pi-code-plugin@swarm-pi-code-plugin-local
```

其他
[Agent Plugins 相容 client](https://agent-plugins.org/compatible-clients)
請以其 local package 流程指向套件根目錄 `plugins/swarm-pi-code-plugin/`。Client 會讀取
`plugin.json`，並在 `skills/<name>/SKILL.md` 發現各個 skill；一般 client 依 frontmatter
`name` 暴露這十個 skills。安裝、啟用、權限、外層 sandbox 與 UI 仍由 client 管理。

本機開發：

```bash
mise run build
mise exec -- node scripts/pi-runner.mjs status --json
mise exec -- node scripts/pi-runner.mjs configure --host codex
```

Packaged runtime 需求為 Node.js 22.19 以上、可執行本機 shell 命令、首次執行可存取 npm
registry，以及可寫入的 plugin 目錄以安裝固定版本依賴；mutation workflow 另需 Git 以支援
worktree-aware 變更。唯讀的套件目錄不支援，會保留既有 bootstrap 錯誤。Repository 開發需求
為 Node.js 24.15.0 以上。Credential 位於 Pi 相容的使用者儲存空間，不會進入 repository
state。Credential 的讀寫可取消；取消的寫入不會 commit，也不會留下殘缺檔案。

固定的 Pi 0.84.4 catalog 會透過既有的 DeepSeek connection 自動提供
`deepseek-v4-flash-vision-exp`，並標示它支援影像輸入。不需要新增 Provider definition
或 setup 欄位。

## Skills

每個 Skill 都可單獨使用，也可作為內部 Workflow node。Host 可以組合
`discover → plan → implement → review → fix/verify`；明確的單一步驟工作仍是單一
Skill。Plugin 不接受使用者自訂 graph YAML 或 JSON。

| Skill | 適用情境 |
| --- | --- |
| `configure` | Provider、模型與完整 setup 預設 |
| `project` | 範圍、路由、安全性、時間與測試政策 |
| `ask` | 一個聚焦的唯讀 repository 問題 |
| `discover` | 未知需求、研究與有邊界的實驗 |
| `plan` | 可決策的實作計畫 |
| `orchestrate` | 有界的獨立架構觀點 |
| `review` | 固定比較點的唯讀審查 |
| `implement` | 已明確授權的變更、修正或重構 |
| `setup` | 專案本機依賴與開發工具 |
| `scaffold` | 經審查的新專案骨架 |

在 Codex 使用對應的 `swarm-pi-code-plugin:swarm-pi-*`，或使用 Claude 對應 command。其他
Agent Plugins 相容 client 會以 frontmatter name（`swarm-pi-configure` 到
`swarm-pi-scaffold`）暴露同樣十個 skills。Runner CLI 仍供 Host adapter 與診斷使用。

## Configuration

瀏覽器設定分為 Providers & Models、Project & Scope、Execution Defaults、Review &
Testing、Safety & Host Assistance、Timing & Recovery、Summary & Migration。優先序固定為
當次 invocation > per-task Configuration > built-in default。

Implement 預設為**撰寫測試**，但不強制 TDD；可在實作前、中、後撰寫。需要選擇時，
Host 會提供合適的方法，例如 unit、integration、contract、regression、E2E、property
test 與**不新增測試**。後者僅代表不新增測試程式，仍必須執行相關既有測試、typecheck、
lint、build 與文件檢查。

## 時間與復原

新 Job 的預設為 ask/plan/review 1 小時，implement/setup/scaffold 4 小時，
discover/orchestrate 8 小時；Configuration 可選 1、4、8、12 小時。這些是依公開觀測
制定的產品政策，不是 Provider SLA。

`--hard-run-limit-ms` 是正式 active-work cap；`--timeout-ms` 是 0.23 的 deprecated
相容 alias。`--wait-timeout-ms` 只限制 Host 等待，不會終止 Job。

Worker 閒置後，liveness probe 會檢查既有 session、transport、tool、process group 與
可用的 provider status，絕不送第二個 LLM prompt。Trusted stream/tool/retry/compaction
progress 會重設探針。三次失敗與 recovery grace 後以 `unresponsive-timeout` 終止；獨立
hard cap 則以 `hard-limit-exceeded` 終止。明確 approval、Host、Human Decision 等待會
暫停 active-time budget。

詳見 [執行時間與復原](docs/execution-time-policy.zh-TW.md)。

## 安全性與相容性

Strict、Adaptive、Lenient、Autopilot、Full-access 保留既有邊界。Host Assistance 保持有界、
correlated、consume-once，且不會擴張權限。`wait-timed-out` 只表示有界 Host 等待結束；
請保留 Job ID 並再次檢查狀態。

Host Actions 0.5 已移除。舊 `hostActions` 設定只保留為已停用的 migration tombstone。
舊 `jobs action-start` 會回傳 `host-actions-removed`；舊 pending record 只保留 audit
evidence，永不執行或自動核准。

## 排除問題

```bash
mise exec -- node scripts/pi-runner.mjs doctor --smoke-test --json
mise exec -- node scripts/pi-runner.mjs jobs list --pending-notifications --json
mise exec -- node scripts/pi-runner.mjs jobs wait --job <job-id> --wait-timeout-ms 15000 --json
```

如果 Configuration 在 Application Support 或 Job state directory 回報 `EPERM`，請保留
form 與既有設定。這代表外層 Host sandbox 阻擋本機 state write；只有在使用者核准下才
可在其外重試同一個本機 command。不要手動建立 runner state files。

## 文件導覽

- [Configuration reference](docs/configuration.md)
- [Configuration field guide](docs/configuration-field-guide.zh-TW.md)
- [執行時間與復原](docs/execution-time-policy.zh-TW.md)
- [Architecture](docs/architecture.md)
- [Host Assistance 與 Discovery](docs/host-assistance-discovery.md)
- [Telemetry](docs/telemetry.md)
- [Threat model](docs/threat-model.md)

## 使用的技術與參考專案

- [Agent Plugins Specification 1.0.0](https://agent-plugins.org/specification)
- [Agent Skills Specification](https://agentskills.io/specification)
- [Claude Code 最新文件](https://code.claude.com/docs/en/overview)
- [OpenAI Codex](https://developers.openai.com/codex/)
- [Pi Coding Agent SDK](https://github.com/earendil-works/pi)，固定使用 `0.84.4`
- [`@carderne/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)，固定使用 `0.0.49`
- [Node.js](https://nodejs.org/)，packaged runtime `22.19+`、repository 開發 `24.15.0+`
- [TypeScript](https://www.typescriptlang.org/)
- [mise](https://mise.jdx.dev/)
- [Playwright](https://playwright.dev/)，固定使用 `1.61.0`
- [Git worktrees](https://git-scm.com/docs/git-worktree)

本 Plugin 的原始概念與 Host workflow 參考了
[apoapps/swarm-code-plugin](https://github.com/apoapps/swarm-code-plugin)。該專案僅作為架構與委派概念的參考；本 repository 是獨立重寫，不重用其原始碼。

角色調度與執行安全設計也參考下列開源專案與文件：

- [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish)：參考 Machine、Role 與 Policy 分離，以及依角色進行模型調度的概念。
- [Pi containerization guidance](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)：參考隔離邊界與未來 whole-process `isolated` 模式方向；[carderne/pi-sandbox](https://github.com/carderne/pi-sandbox) 則參考 macOS Seatbelt 與 Linux Bubblewrap 的沙盒 shell 作法。
- [r4vi/pi-auto-mode](https://github.com/r4vi/pi-auto-mode) 與 [czottmann/pi-automode](https://github.com/czottmann/pi-automode)：參考自適應權限 classifier、政策決策與核准流程。
- [farion1231/cc-switch](https://github.com/farion1231/cc-switch)：參考模型供應商表單與協定選擇的調查；本 Plugin 使用 Pi 原生 adapter，不使用 CC-Switch 的協定轉譯 proxy。
- [mattpocock/skills](https://github.com/mattpocock/skills)：參考 Skill trigger、anti-trigger、evidence、停止條件與 focused reference。

以上專案與文件僅為設計參考。本 repository 是獨立實作：不載入第三方完整 extension、不複製第三方 source code，也不複製第三方 prompts。

## 授權

本專案採用 [MIT License](LICENSE)。Copyright (c) 2026 Jason Hsieh。
