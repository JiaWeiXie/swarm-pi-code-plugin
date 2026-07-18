# Discover Sandbox 與 Host 自主性計畫

日期：2026-07-13

狀態：實作紀錄；執行期、文件與 Host 介面工作進行中

## 事件與根因

失敗的 Evobox Discover Job 使用了舊快照，其專案根目錄為空。撇開這個過時的範圍不談，立即造成 singleton 失敗的原因是 Sandbox 所有權。Discover 父工作建立了一個程序全域的 Sandbox runtime，並從 Research 持有到等待閘門。接著 Experiment 子工作在同一個 Node 程序中執行，並嘗試建立第二個 runtime manager。上游 Sandbox backend 每個程序只允許一個存活中的 manager，因此子工作在執行計畫中的實驗前就失敗了。

將 Discover 改為 Strict 會掩蓋這個生命週期錯誤，同時改變 Job 的政策快照。這不是可接受的修正。Discover 必須使用 Job 啟動時選定的模式、根目錄與網路規則，且每個階段專屬的政策視圖都必須以密碼學方式綁定至不可變的父快照。

## 決策

### 設定與相容性

- 新建立的設定以 Adaptive 模式開始。
- 具備明確模式的持久化設定會保留該模式。
- 沒有模式的舊版設定持續正規化為 Strict。這可避免對既有專案默默授予 Shell 或網路能力。
- 新的 Host Assistance 政策預設為 Host-first review、Reversible scope 與 Discovery gate auto-review。舊版已儲存政策中缺少的欄位會正規化為 User-only、Context-only 與不自動審查閘門。
- 每個執行中的 Job 使用其不可變政策快照。儲存設定只影響後續 Job。
- 選定主要模型後，Adaptive 需要分類器。當新設定尚未包含明確的分類器選擇時，主要模型會成為初始分類器。Provider 設定不完整仍可儲存，但在模型可用前，Job readiness 仍會 fail-closed。

### 階段範圍的 Sandbox 所有權

Discover 不再在整個生命週期中擁有 Sandbox。每個需要工具的階段都會建立一個 runtime，並在 `finally` 中釋放：

1. Research 使用唯讀 Sandbox。
2. 在呈現 Research 閘門前釋放 Sandbox。
3. Experiment 在工作專屬的隔離工作樹中使用獨立的實作 Sandbox。
4. 子工作繼承父工作的模式、根目錄、信任網域與網路政策。它與父工作使用相同的 Adaptive 網路授權器。其 `experimenter` 角色與停用的 Advisor 會產生不同的階段政策文件，因此不得重用父工作的雜湊。相反地，標準 v3 子快照會將確切的父雜湊納入 `parentPolicyHash`；這個來源綁定本身也包含在子階段雜湊中。
5. Experiment Sandbox 可以讀取其關聯工作樹的 Git 管理連結，以進行基準與乾淨重播檢查，但這些路徑仍禁止寫入。在 macOS 上，它優先使用直接的 Command Line Tools binary，避免 `xcrun` shim 需要寫入 Host 快取。
6. Convergence 與每次可選的 Advisor 諮詢都使用新的唯讀 Sandbox。
7. 成功、錯誤、取消與逾時路徑都會釋放目前的階段 runtime。等待閘門時絕不持有 Sandbox。

這個順序保留上游程序全域 singleton 不重疊的限制。失敗的 Experiment 會保留其隔離工作樹與持久化 Job 證據，供調查使用；清理仍是明確的 Host 或使用者動作。

### Host Assistance 准入

`request_host_assistance` 是控制平面請求，而不是一般 Worker 工具動作。因此它只繞過一般工具分類器，接著進入自己的型別化准入路徑。該路徑仍會強制執行快照模式、內容類別、資料分類、請求配額、工作階段唯一性、扇出、到期時間與持久化關聯。Bash、檔案系統與網路工具則繼續通過一般分類器。

每個新的 Worker 請求都必須包含描述目的、阻礙、最小存取權、精確目標、副作用、暴露、失敗模式、緩解措施、可逆性、回滾、驗證、提議風險與安全替代方案的 `WorkerAssessment`。持久化的舊版請求可以省略此欄位，以保持舊 Job 可讀。Worker 風險是證據而非權威；Host 模型會獨立裁決。

### Host 優先裁決

只有目前作用中的 Codex 或 Claude Code Host turn 中的模型可以產生自動決策。它會讀取完整的持久化請求、原始 Job 意圖、角色上限、專案政策、Sandbox 根目錄、動作指紋與政策雜湊。如果動作位於快照上限內，它會寫入 `HostAdjudicationReceipt`，並以 `--adjudication-file` 呼叫既有 CLI。

執行期會再次驗證收據。有效的 Host-model allow 必須：

- 識別相同的 Host 與確切的 v3 政策雜湊；
- 符合確切的 64 字元動作指紋；
- 表示低或中風險、意圖相符與 `autoResolved: true`；
- 包含完整的 WorkerAssessment；
- 保持在已設定的 Context-only、Read-only 或 Reversible 上限內；
- 使用一次動作能力租約進行工具核准。

唯讀的公開內容可以自動解決。只有當原始 Job 已帶有變更意圖，且目標仍在快照工作區或工作專屬工作樹內時，才可核准可逆的本機變更。只有在啟用閘門自動審查時，Discovery 決策才可針對已識別的 Discovery 閘門自動解決，而且自動決策只能選擇有界的 `approve` 結果。

Strict 模式不能由 Host 收據擴張。私人連接器、秘密、Git 中繼資料、工作區逃逸、不完整或不可逆變更、刪除、交付動作、部署、發布、傳訊、交易、動作建議、角色提升與不確定意圖都不在自動上限內。它們會回到使用者決策，或由政策硬拒絕。

復原 hooks、SessionStart、watch replay、逾時與背景程序只會投射待處理或已解決的事件。它們絕不產生收據、解決請求或發出租約。重播事件使用穩定識別碼；同一個持久化請求被解決兩次會被拒絕。

### 稽核與通知

收據會記錄 principal、Host、可選的模型識別碼、決策、風險、理由、限制、意圖相符、指紋、政策雜湊、自動解決旗標與時間戳。核准與 Host Assistance 解決事件只公開安全的 principal／風險／自動解決摘要。完整請求、評估、收據與租約會保留在經遮罩的 Job 稽核匯出中。

未提供收據時，現有命令維持手動含義：

```text
jobs approve --job JOB --approval ID [--approval-scope once|job]
jobs host-respond --job JOB --request ID --response-file RESPONSE
jobs decide --job JOB --request ID --response-file RESPONSE
```

作用中的 Host 模型會加入 `--adjudication-file RECEIPT`。Runtime 不信任檔名或 Host 敘事；在改變狀態前，會立即重新驗證持久化待處理紀錄、快照、指紋與上限。

## 驗證矩陣

只有在以下所有性質都由可執行測試或打包 Host 驗證涵蓋時，實作才算接受：

| 案例 | 預期結果 |
| --- | --- |
| Research → Gate → Experiment → Convergence | 階段 runtime 絕不重疊，且各自都會釋放 |
| Experiment 失敗、取消、逾時 | 目前 runtime 會釋放；證據保留 |
| Adaptive 子工作網路請求 | 使用共用授權器與快照政策 |
| 舊版設定缺少新的 Host 欄位 | User-only；不自動擴張 |
| 公開唯讀內容 | 作用中的 Host 可用確切收據解決 |
| 可逆且在範圍內的實作寫入 | 一個確切的 Host-model 租約 |
| 指紋、目標、命令或政策變更 | 收據或租約無效 |
| Strict Job | Host 收據不能新增能力 |
| 私人連接器、秘密、Git、交付、即時變更 | 使用者決策或硬拒絕 |
| SessionStart／watch replay | 僅通知；無收據或租約 |
| 重複解決／重播 | 穩定事件，且不重複狀態轉換 |
| Codex 與 Claude fixture | 相同決策與指紋；身份中繼資料可以不同 |

最終開發驗證還包括目標測試、型別檢查、lint、格式化、完整測試套件、打包執行期一致性、文件影響檢查、技能驗證、兩個 Plugin manifest、Claude development plugin validator、Codex cachebuster／重新安裝檢查，以及此 Plugin 內受控且全新的 Discover fixture。Fixture 必須在兩個持久化審查閘門暫停，證明等待時沒有持有 Sandbox，使用確切的 Host 收據解決每個閘門，並在不使用外部產品儲存庫的情況下完成隔離 Experiment。

較早的外部整合驗證揭露 Host-first shell 分類中的假陰性：對兩個工作區檔案執行有界 `sha256sum` 時，收到一般的部分可逆評估，並一直等待到 Job 截止時間。

Checksum 檢查現在已納入狹窄的可信唯讀語法，測試仍保留 fail-closed traversal 與外部絕對路徑行為。

後來的受控驗證在工具鏈版本探測與非寫入檔案比較中發現相同的假陰性。語法現在只辨識有界的 `rustc`／`cargo` 版本形式與兩檔案 `cmp`／`diff` 形式；編譯、測試、輸出選項、traversal 與外部路徑仍在自動上限之外。

Screenshot-Impact: reviewed-current — `parentPolicyHash` 與關聯工作樹 Git 讀取邊界是內部 Job／稽核與執行期行為。它們沒有新增設定欄位或版面變更，因此目前的 Execution Safety 與 Host Assistance 螢幕截圖仍然準確。

## 推出與回滾

此變更不會提高發布版本。開發用 Codex manifest cachebuster 可能變更，讓新的 Codex task 載入更新後的 skill 與 runtime。已安裝版本檢查器仍必須為兩個 Host 報告一個同步的語意版本。

執行期回滾採保守方式：停用 Host-first review（User-only）、停用 Discovery gate auto-review，或為後續 Job 選擇 Strict。現有執行中的 Job 保留原始快照。任何回滾路徑都不會改寫持久化 Job、刪除實驗工作樹或擴大租約。
