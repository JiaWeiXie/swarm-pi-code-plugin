# 功能分析：目前索引

此目錄是 2026-07-11 開始的功能研究之維護決策紀錄。這是內部規劃資料，不是使用者指南。目前的產品行為以根目錄 README 與 `docs/` 下的參考文件為準。

原始研究逐漸形成數份互相重疊的提案清單。這些已被取代的草稿在 2026-07-13 移除，剩餘決策已整合至此。Git 歷史仍是原始訪談、逐行觀察與提案編號的來源。

## 維護中的文件

| 文件 | 用途 |
| --- | --- |
| [01-project-analysis.md](01-project-analysis.md) | 目前 0.5.0 能力與缺口評估 |
| [04-first-principles-review.md](04-first-principles-review.md) | 持久的 Question/Delete/Simplify 決策 |
| [05-roadmap.md](05-roadmap.md) | 以證據為基礎的剩餘路線圖 |
| [09-claude-codex-concurrency-plan.md](09-claude-codex-concurrency-plan.md) | 共用控制平面的並行契約與剩餘風險 |
| [10-sandbox-host-autonomy-plan.md](10-sandbox-host-autonomy-plan.md) | Discover Sandbox 生命週期與 Host 優先裁決的實作紀錄 |

## 目前結果

研究結果不再是一項提案對應一項功能。實作後的產品更適合描述為四組能力：

1. 有界的委派控制平面：受強制執行的專案政策、限定範圍的工具、核准租約、持久化工作、工作樹產物、稽核匯出，以及明確的物化操作。
2. 通用 Host Assistance：Worker 可以請求有界的工作區、Web、文件、論文、連接器、技能或人工決策協助，並在同一個執行中的工作階段消費一個關聯回應。
3. Discovery：固定的研究 → 實驗 → 收斂流程，搭配結構描述閘門、人工閘門，以及隔離且不可物化的實驗子工作。
4. 隔離的 Host Actions：只有在明確確認與政策檢查後，惰性的建議才可以轉成獨立的 `host-broker` 子工作。

幾項規劃中的保證仍未完成。尤其是，目前實作尚未提供決定性的命令執行驗證器、執行期 Review Coordinator、自動 Question/Delete/Simplify 收斂，或實驗命令的控制平面重播。這些缺口是正式的路線圖項目，不得描述為已完成的行為。

## 明確的非目標

- 任意的使用者自訂工作流程 DAG；
- 外部的儲存庫答案語意／結果快取；
- Pi Worker 內建的原生 MCP 用戶端；
- 跨工作或跨工作區的模型工作階段重用；
- 自動執行 Host 建議；
- 自動 commit、merge、push、部署或物化實驗結果。
