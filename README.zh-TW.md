# swarm-pi-code-plugin

[English](README.md)

Swarm Pi 將 Claude Code 與 Codex 連接到受邊界限制的 Pi Worker，可處理以 repository
為依據的提問、規劃、審查、Discovery、設定、Scaffold 與已授權的實作。Host 保留意圖、
核准、驗證與交付權；Pi 不擁有 commit、merge、push、部署、訊息或交易權限。

## 快速開始

先從共用 marketplace 安裝，再從 Claude Code 或 Codex 開啟 Configuration。連接
Provider、選擇主要／fallback 模型、設定角色與專案範圍，最後儲存。

```bash
claude plugin marketplace add https://github.com/JiaWeiXie/swarm-pi-code-plugin
claude plugin install swarm-pi-code-plugin@swarm-pi-code-plugin
```

本機開發：

```bash
mise run build
mise exec -- node scripts/pi-runner.mjs status --json
mise exec -- node scripts/pi-runner.mjs configure --host codex
```

需求為 Node.js 24.15.0 以上、支援的 Claude Code 或 Codex Host；需要 worktree-aware
mutation 時也需要 Git repository。Credential 位於 Pi 相容的使用者儲存空間，不會進入
repository state。

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

在 Codex 使用對應的 `swarm-pi-code-plugin:swarm-pi-*`，或使用 Claude 對應 command。
Runner CLI 仍供 Host adapter 與診斷使用。

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

## Inspirations

Skill 結構與工程方法參考了 [mattpocock/skills](https://github.com/mattpocock/skills)。本
repository 是獨立實作：採納精確 trigger、anti-trigger、evidence、停止條件與 focused
reference 的方法，不直接複製第三方提示詞。
