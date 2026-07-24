# 設定欄位指南

本指南解釋設定頁面中較不直覺的欄位：它們有什麼作用、什麼情況應該留白，
以及會如何影響委派工作。頁面會在控制項旁提供最短提示，並以原生 **Tips**
展開區顯示訣竅；本文件則是詳細參考。

除非個別段落另有說明：

- 設定會在 Job 開始時建立快照；
- 修改設定只影響未來 Job，不會改寫已經啟動的 Job；
- 機密欄位留白會保留既有憑證，非機密選填欄位留白則代表「未設定」；
- 數字欄位留白是錯誤，不會被默默當成 0 或預設值；
- 範例只是顯示文字，不包含可用憑證，也不會自動成為設定值。

儲存、交易、協定與 server lifecycle 的技術細節，請參考
[設定參考](configuration.md)。

快速入口：[整體概念](#mental-model) · [安全預設](#safe-defaults) ·
[Provider](#provider-fields) · [Model／Role](#model-role-keywords) ·
[Adaptive rules](#adaptive-policy) · [Decision／Background](#workflow-keywords) ·
[Host Assistance](#host-assistance) · [Advisor](#advisor) ·
[Host Actions](#host-actions) · [Project goal](#project-goal) ·
[Working area](#working-area) · [Delegated work](#delegated-work)

<a id="mental-model"></a>
## 先建立整體概念：誰在做什麼

設定頁不是在設定「一個更聰明的聊天機器人」，而是在設定一條受限制的委派流程：

```text
你提出需求
  ↓
Host（目前與你對話的 Codex 或 Claude）先理解需求、保留決定權
  ↓
Job（一次有明確目的與邊界的委派工作）
  ↓
Worker（由 Pi 啟動、負責實際研究或修改的模型工作階段）
  ↓
Sandbox + Policy 檢查 Worker 想用的工具、路徑與網路
  ↓
結果回到 Host，由 Host 驗證並交付給你
```

以下是最常出現、也最容易混淆的詞：

| Keyword | 白話意思 | 實際例子 |
| --- | --- | --- |
| **Host** | 目前直接和你對話、替你做最後判斷的 Codex 或 Claude。Host 不是背景 hook。 | Worker 要讀官方文件時，Host 判斷是否符合原始需求。 |
| **Worker** | Host 委派出去執行一項工作的人員角色；這裡是受限制的 Pi model session。 | Reviewer Worker 只檢查 diff；Executor Worker 才能在允許範圍修改檔案。 |
| **Job** | 一次委派工作的完整紀錄，有自己的需求、設定、狀態與結果。 | 「Review 目前 branch」是一個 Job；之後「修正 finding」是另一個 Job。 |
| **Snapshot** | Job 開始時把設定拍成一份不可變副本。 | Job 開始後把 Sandbox 從 Adaptive 改成 Strict，不會改變正在執行的 Job。 |
| **Policy** | 判斷「誰可以在什麼條件下做什麼」的規則集合。 | Executor 可以寫 `src/`，但 repository deny rule 可再禁止某個網域。 |
| **Sandbox** | 作業系統層的活動圍欄，主要限制檔案寫入、刪除、process 與網路。 | Worker 即使產生錯誤 command，也不能任意寫到 workspace 外。 |
| **Capability** | 一類具體能力或權限，不是模型名稱。 | `network.connect` 代表建立對外連線；`filesystem.write-workspace` 代表寫入 workspace。 |
| **Scope／roots** | Capability 可以作用的範圍。`roots` 通常是允許讀寫的資料夾。 | 有寫入能力不等於能寫所有地方；root 只有 `docs/` 就不能改 `src/`。 |
| **Gate** | 流程一定要停下來檢查的關卡，不是一般提示。 | Discovery 完成 research 後，必須通過 gate 才能開始 experiment。 |
| **Approval** | 對一個目前被擋住的精確動作作出允許或拒絕。 | 核准一次 `npm run test:build`，不等於核准所有 shell command。 |
| **Fingerprint** | 根據 command、路徑、目的地與 policy 產生的動作身分。內容一變就視為另一個動作。 | `git status` 的核准不能拿去執行 `git push`。 |
| **Lease** | 有期限、次數與精確範圍的臨時權限票券。不是永久提升權限。 | Host 核准一個可逆修改後，Worker 只可用該 lease 執行那個 fingerprint。 |
| **Fallback** | 第一個選擇失敗時依序嘗試的備援。 | Primary model 無法使用時，改用下一個已設定 model。 |
| **Delivery** | 把本機結果正式送出或造成外部效果的階段。 | Commit、push、publish、deploy、message、transaction 都屬於 delivery。 |
| **Materialization** | 把隔離 staging／worktree 的 artifact 套用到真正目標專案。 | Scaffold 預覽完成不會自動出現在目前 workspace。 |
| **Canonical** | Runtime 認得的標準固定名稱。 | 畫面 alias `planning` 對應 canonical Job kind `plan`。 |
| **Legacy** | 舊版本已儲存、仍需相容讀取的資料。 | 缺少 Host-first 欄位的舊設定會保持 User-only，直到重新儲存。 |
| **Redacted** | 敏感值已移除或替換，只保留調查需要的摘要。 | Classifier diagnostics 不應包含 API key。 |
| **Hook／Watcher／Replay** | 用來通知或恢復顯示狀態的背景機制，不是正在對話的 Host。 | 它們可以顯示 pending approval，但不能自行核准。 |

### 一個完整例子

假設你說：「請更新 `docs/` 裡的設定指南，但不要 commit。」

1. Host 建立一個有「修改文件」意圖的 Job。
2. Job snapshot 記住當下 Sandbox mode、允許的 task type 與 write roots。
3. Worker 讀取文件；讀取能力叫 `filesystem.read-workspace`。
4. Worker 若需要查公開 API 文件，可透過 Host Assistance 請 Host 取得內容。
5. Worker 修改 `docs/`；Sandbox 與 policy 同時確認路徑在 write roots 內。
6. Worker 若嘗試 `git commit`，delivery gate 仍會阻擋，因為原始需求明確說不要。
7. 結果回到 Host；Host 檢查 diff 和測試，再向你報告。

這也是為什麼「模型看起來能做」不等於「它真的有權限做」。能力、範圍、原始
意圖與 gate 必須同時允許。

<a id="safe-defaults"></a>
## 完全不確定時，先這樣設定

| 區塊 | 建議起點 | 原因 |
| --- | --- | --- |
| Provider 額外欄位 | 除非 provider 管理者明確給值，否則留白 | 填錯 ID／region 通常只會把 request 送到錯誤資源。 |
| Custom endpoint | 只有自架、本機或相容服務才設定 | 一般 OpenAI／Anthropic 帳號應使用內建 connection。 |
| Sandbox | **Adaptive** | 保留必要工具，但讓不確定或高風險動作停下來判斷。 |
| Structured policy rules | 先保持空白 | Roots、role ceiling 與既有 deny 已提供基本邊界；錯誤 allow rule 不會帶來你期待的效果。 |
| Host Assistance | On／Host model first／Bounded reversible changes | 讓 Host 先判斷安全的小範圍請求，無法確定再問你。 |
| Context allowance／requests／fan-out | Standard／`4`／`2` | 單次最多回傳 32,768 個 context 字元，並限制請求總數與並行數。 |
| Private connectors | Ask each time | 私有資料不應由模型自動判斷放行。 |
| Advisor | Off | 只有複雜 plan、review 或 discovery 需要額外觀點時再開。 |
| Host Actions 0.5 | Off | 這是進階的隔離執行機制，不是一般委派工作的必要開關。 |
| Project goal | 寫產品長期成果 | 讓未來 Job 知道共同方向，而不是重複今天的 ticket。 |
| Delegated work | 只勾確實要委派的類型 | 未勾選的工作會在啟動前被拒絕，這是安全邊界。 |

這些是保守且可工作的起點，不是效能最佳化公式。之後應根據實際 Job 為什麼被
擋住，再只調整對應欄位。

<a id="provider-fields"></a>
## Provider 額外與進階欄位

Provider 欄位由 capability registry 產生。欄位旁的說明是 registry metadata，
不是針對某個畫面硬寫的例外。除非帳號、資源擁有者或官方設定文件要求明確
路由，否則選填欄位通常應保持空白。

### 先懂 Provider 這串關係

```text
Connection → Adapter → Protocol → Endpoint → Provider 的某個 Model
```

- **Provider**：提供模型服務的系統，例如 OpenAI、Anthropic、Azure OpenAI，
  也可能是你本機的 Ollama。它回答「服務是誰提供的」。
- **Connection**：這個專案連到某個 Provider 的一組設定，包含驗證方式與路由。
  同一個 Provider 可以有多個 connection，例如公司與個人 OpenAI project。
- **Model**：實際產生回答的模型 ID。Provider 是服務，Model 是服務內的選項。
- **Adapter**：Plugin 內負責把統一的模型操作轉成特定 API 呼叫的程式。通常由
  plugin 決定，不需要自己選。
- **Protocol**：Client 和 server 說話的格式，例如 OpenAI Responses 或 Anthropic
  Messages。即使兩個 server 都收 JSON，欄位與 tool-call 規則仍可能不同。
- **Endpoint／base URL**：request 實際送往的網路地址。它像 API 的門牌，不是
  model 名稱，也不應包含 credential。
- **Authentication／credential**：證明你可以使用服務的方法與秘密，例如 API
  key、OAuth 或 ambient cloud identity。

如果你使用內建 Provider，通常只要選驗證方式與模型；Protocol 和 Adapter 已固定。
只有自架 server、local model 或第三方相容服務才需要自己理解 endpoint/protocol。

驗證方式也代表不同的帳號邊界：

- **API key**：Provider 發出的秘密字串，通常對應 API 用量與帳單。應放在 Credential
  欄位，不能放 URL、header literal、Project goal 或文件。
- **OAuth／subscription sign-in**：瀏覽器或 device-code 登入後取得受限 token，
  適合 ChatGPT、Anthropic 或 Copilot 訂閱連線。ChatGPT subscription 不等於 OpenAI
  API key，也不會自動給 API billing access。
- **Ambient identity**：使用本機已登入的 cloud CLI／profile，不把秘密複製進表單。
- **No authentication**：只適合刻意無驗證的 loopback 本機服務；不能因為不知道
  credential 在哪裡就選它。

### 常見雲端路由詞

| Keyword | 白話意思 | 填錯時通常會怎樣 |
| --- | --- | --- |
| **Organization／Account** | 最上層的帳號或組織容器 | 憑證有效，但找不到預期 project／資源。 |
| **Project** | 組織底下用來分帳、分權或隔離資源的容器 | Request 記到錯誤 project，或被拒絕。 |
| **Resource** | Azure 等雲端平台上實際建立的服務資源 | Endpoint 無法解析，或 deployment 不存在。 |
| **Region／Location** | 雲端資源所在的實體區域 | Model 在該區域不可用，或連到錯誤資料邊界。 |
| **Deployment** | 你在雲端資源裡替某個 model 建立的可呼叫名稱 | Model ID 正確，但 API 回報 deployment not found。 |
| **Profile** | 本機 credential 設定檔的名稱／選擇器 | 選到另一個帳號，或找不到 ambient credential。 |
| **Header** | 隨 HTTP request 一起送出的額外名稱和值 | 路由或 attribution 失敗；若誤放秘密可能造成外洩。 |
| **Controlled header** | Plugin 明確允許、視為非機密 literal 的 header | 不能用來自由注入 Authorization 或任意 JSON。 |
| **Ambient identity** | 不在表單貼 key，而是執行時使用本機已登入的 AWS／Google 身分 | 本機登入過期時，未來 Job 會明確失敗。 |

### Discovery、verification 與 readiness 不一樣

- **Configured**：欄位格式正確，plugin 知道要怎麼連；尚未證明 server 能回答。
- **Discovered**：成功從模型清單 endpoint 讀到 model ID；只證明「看得到清單」。
- **Verified**：對選定 model 發出最小 generation request 並成功；這才證明目前可用。
- **Blocked**：缺 credential、adapter 不支援或驗證失敗，目前不能執行。

例如本機 server 的 `/models` 可以正常回應，但 `/responses` 尚未實作，狀態就可能是
Discovered 而不是 Verified。

設定結構、catalog／auth 可用性與即時健康狀態是三件不同的事。已儲存的 model 即使
provider 暫時離線或不再列出它，設定結構仍可能有效。設定頁會保留這個引用讓使用者修復，
但不會把它提供為新的選項；儲存無關設定時會回報 degraded health，而不是破壞或拒絕既有
設定。新增或變更 route 仍必須通過可用性與必要驗證。

| 欄位 | 預設或空白行為 | 何時填寫 | 不要填入 |
| --- | --- | --- | --- |
| Organization／project ID | 使用 provider 或憑證的預設 scope | 一組憑證可存取多個 scope，且必須指定 ID | API key、顯示名稱 |
| Region／location | 選填時使用環境或 provider 預設 | 模型只存在特定雲端區域 | 猜測值或任何秘密 |
| Deployment mapping | 預設模型 ID 與 deployment 同名 | Azure deployment 名稱與模型 ID 不同 | JSON、空白或缺少 `model=deployment` 的項目 |
| Attribution header | 預設不傳送 | Provider 政策要求標示應用程式來源 | 憑證或使用者私密資料 |
| Cache retention | 自動使用短期／provider 管理方式 | 已了解並接受保留期限的取捨 | 把它當成品質或 context window 控制 |

成功交易式儲存後，Provider 設定才會影響未來 Job；不會改寫正在執行中的
模型快照。

<a id="openai-organization"></a>
### OpenAI Organization ID

- **用途：** 選擇性地把 OpenAI request 限定在某個 organization。
- **留白：** 不送出明確 organization，使用憑證預設值。
- **建議：** 除非 API 帳號明確要求，否則留白。
- **安全範例：** `org_example`。
- **常見錯誤：** 這不是 API key，不應放入憑證。

<a id="openai-project"></a>
### OpenAI Project ID

- **用途：** 一組憑證可存取多個 project 時，選擇實際 project。
- **留白：** 使用憑證預設 project。
- **安全範例：** `proj_example`。
- **常見錯誤：** 請使用 project ID，不是顯示名稱。

<a id="prompt-cache-retention"></a>
### Prompt cache retention

**Prompt cache** 是 provider 暫時重用相同輸入前綴的機制，目的是減少重複處理的
延遲或費用；它不是聊天記憶、不是把整個 Job 永久保存，也不會增加模型可以讀的
字數。**Retention** 是這份可重用 cache 在 provider 端保留多久。

- **Automatic** 是預設值，使用 adapter 的短期或 provider 管理行為。
- 只有 direct API 與驗證方式支援時才會出現 **Extended**。目前 OpenAI
  選項為 24 小時，Anthropic 為 1 小時。
- 延長保留可能改變隱私、延遲與 provider 端資料保留取捨，不會增加模型智力
  或 context window。
- OAuth 或不支援的 adapter 可能隱藏或拒絕 Extended。

<a id="anthropic-beta"></a>
### Anthropic beta features

- **留白：** 不送出 `Anthropic-Beta` literal。
- 只有官方文件提供精確功能值時才填寫。
- **安全格式：** `feature-name-YYYY-MM-DD`。
- 不要貼入 raw header JSON 或 authorization value。

<a id="openrouter-attribution"></a>
### OpenRouter Application URL 與 title

這兩個選填值會成為受控的 `HTTP-Referer` 與 `X-Title` literal header。
除非需要 attribution，否則兩者都留白。URL 請使用不含秘密的 HTTPS 專案網址，
title 請使用一般應用程式名稱；兩者都不可包含憑證或使用者私密資料。

<a id="azure-openai-routing"></a>
### Azure OpenAI 路由

| 欄位 | 填寫方式 |
| --- | --- |
| Azure endpoint | 使用 `https://resource-name.openai.azure.com` 之類的 resource root，不要填 `/responses` URL。 |
| Resource name | endpoint 的替代方式；至少 endpoint 或 resource name 要有一項。 |
| API version | 除非資源擁有者要求特定版本，否則留白使用 adapter 預設值。 |
| Deployment mapping | 選填、逗號分隔的 `model=deployment`；名稱相同時留白。 |

固定版本 runtime 的這個 adapter 使用 API key。畫面顯示 Microsoft Entra
capability 提醒，不代表 plugin 已能執行 Entra authentication。

<a id="cloudflare-routing"></a>
### Cloudflare Account 與 Gateway ID

Account ID 與 Gateway ID 是從 Cloudflare dashboard 複製的非機密路由識別碼，
各自對應的連線會要求它們。不要把 API token 貼進 ID 欄位。

<a id="bedrock-identity"></a>
### Amazon Bedrock profile 與 region

- **AWS profile 留白：** 使用預設 ambient AWS identity。
- **AWS region 留白：** 使用 ambient／預設 region。
- 只有指定模型確實需要時，才設定命名 profile 或 region。
- `development` 之類的 profile 名稱是選擇器，不是憑證本身。
- Region 範例：`us-east-1`。

Ambient identity 會在未來 Job 執行時解析，因此憑證之後被撤銷仍會明確失敗。

<a id="vertex-routing"></a>
### Google Vertex project 與 location

兩個欄位分別把 request 路由到指定 Google Cloud project 與區域。Project ID
範例為 `example-project`，location 範例為 `us-central1`。不要把 service-account
JSON 或其他秘密放進任一欄位；驗證仍由所選 API-key 或 ambient 邊界負責。

<a id="custom-endpoints"></a>
## 自訂與本機端點

自訂連線會分開處理 protocol、endpoint identity、authentication、模型清單探索、
API 驗證與模型 override。成功列出模型不代表 generation 已通過驗證。

<a id="custom-protocol"></a>
### API protocol

只能選擇 server 文件明確支援的一種：

- OpenAI Chat Completions；
- OpenAI Responses；
- Anthropic Messages。

Plugin 不會逐一嘗試後猜測。變更 protocol 會改變 request semantics 與 endpoint
identity。

<a id="custom-server-url"></a>
### Server URL

- 填 service／API root，不要填 `/chat/completions`、`/responses` 或
  `/v1/messages`。
- HTTP 只允許 loopback endpoint；其他位置請用 HTTPS。
- 安全本機範例：`http://127.0.0.1:11434`。
- 含 `user:password@`、秘密 query parameter、跨 origin redirect 或 cloud
  metadata 目的地的 URL 會被拒絕。

<a id="custom-authentication"></a>
### Authentication 與 secret header

| 選項 | 使用時機 |
| --- | --- |
| API key | 所選 protocol 使用標準 credential header。 |
| No authentication | Loopback／本機服務刻意不需要驗證。 |
| API key + secret header | Server 除了原生 adapter authentication，還要求一個支援的 secret-header 名稱。 |

編輯既有連線時，Credential 留白會保留已儲存憑證。秘密只存在當次 session 的
draft vault，不會回傳瀏覽器，也不會進入文件、state 或 model configuration。

<a id="custom-models-endpoint"></a>
### Models endpoint

這是只覆寫模型清單 URL 的選填欄位；一般請留白使用 protocol 預設值。它必須與
Server URL 同源。成功載入模型 ID 只會變成 discovered；仍需真正的最小 generation
request 才能成為 verified。

<a id="custom-controlled-headers"></a>
### 受控 literal headers

進階欄位 `HTTP-Referer`、`X-Title` 與 `Anthropic-Beta` 是 allowlist 內的非機密
literal。不可放入 raw header JSON、shell command、環境變數展開或 authorization
value。除非 server／provider 明確要求，否則留白。

<a id="custom-manual-models"></a>
### 手動 Model ID

模型清單探索不可用時，每行輸入一個文件記載的精確 ID。手動 ID 只代表
configured，不代表 verified；Job 使用前仍應選取並驗證模型。

<a id="custom-advanced-settings"></a>
### 進階連線與模型設定

- **Connection name** 是本機顯示名稱。
- **API base URL** 顯示 canonical saved root；變更後會改變未來 request 路由。
- **Runtime adapter** 由 protocol 推導，只能讀取。
- **Context window／max output** 通常留白，使用 provider metadata。Override 必須是
  正整數，而且不能證明 server 確實支援所宣告容量。

這裡的 **Context window** 是一次 model request 中「輸入 + 已產生輸出」可容納的
token 總量；**Max output** 是其中最多可留給模型回答的 token。Token 不是字數，
不同語言與內容的換算不同。把數值填得比 server 實際能力大，不會升級模型，反而
可能讓長 Job 在 API 層失敗。只有 server 管理者或官方 metadata 明確提供值時才
override；一般保持 Automatic。

<a id="model-role-keywords"></a>
## Model 選擇與 Role routing keyword

| Keyword | 白話意思 | 如何使用 |
| --- | --- | --- |
| **Primary model** | 專案一般工作最先嘗試的預設 model。 | 選已 verified、品質與成本符合主要用途的 model。 |
| **Fallback order** | Primary 失敗後依序嘗試的 model 清單。 | 排的是「嘗試順序」，不是同時呼叫或投票。 |
| **Role** | Worker 在一個 Job 裡的職責與 capability ceiling。 | Reviewer 偏唯讀；Executor 才負責已授權修改。 |
| **Role routing** | 指定某個 role 優先使用哪些 model。 | 可讓 review 用擅長程式審查的 model、plan 用長推理 model。 |
| **Model chain** | 某個 role 的 primary + fallback 順序。 | 第一個 provider error 後才嘗試下一個。 |
| **Thinking level** | 請 model 使用的推理努力提示，不是安全等級。 | Higher 通常較慢、用量較多；model 不支援時 runtime 會降低。 |
| **Max attempts** | 這個 role 一次 Job 最多嘗試幾個候選／回合。 | 它限制 retry，不會讓不可逆外部結果自動重試。 |
| **Classifier model** | 只用來評估 Adaptive action 風險的 model。 | 它不是 Worker model，也不負責寫程式。 |

例如 reviewer chain 是 `[Model A, Model B]`：Job 先用 A；只有 A 無法完成或 provider
失敗時才用 B。這不是 Advisor 的兩個 perspectives，也不是同時讓兩個 model review。

<a id="adaptive-policy"></a>
## Adaptive authorization — Structured policy rules

Structured rules 用來細化 Adaptive 判斷，永遠不能擴大 Strict、workspace roots、
role capability、使用者原始意圖或明確 delivery gate。優先順序為 deny 高於 ask，
ask 高於 allow。

### Sandbox mode 與 authorization 有什麼不同

- **Strict**：不提供任意 Bash，只暴露經過限制的工具。適合需要最小能力的工作。
- **Adaptive**：可以提出 shell／network 等動作，但先由硬性 policy、rule 與 classifier
  判斷；不確定時依設定拒絕或等待 supervisor。
- **Lenient**：在 OS Sandbox 仍存在的前提下提供較寬的 shell／network。不是「沒有
  Sandbox」，但 Worker 可見資料更可能被送往外部服務。
- **Autopilot**：維持與 Lenient 相同的 OS Sandbox 隔離（同樣需要沙盒後端），但會讓
  例行 shell 在無人監督下自動執行，不會停下等待 supervisor；這種例行 shell 自動化是
  該模式的內建特性，而 git／deploy 仍必須通過人工核准 gate。
- **Full-access**：移除 Plugin 自己的 OS Sandbox，讓 Worker 的 Bash 不再被包裹，因此
  與 Lenient 不同，就本 Plugin 而言它*確實*未沙盒化；Worker 的觸及範圍完全取決於 Host
  自己的沙盒。它不需要沙盒後端，因此一律可選。
- **Authorization**：針對某一個動作判斷允許、詢問或拒絕。Sandbox 是外層圍欄，
  authorization 是圍欄內的通行判斷；兩者都必須通過。
- **Classifier**：專門閱讀「提議中的動作 + 有限 policy context」並評估風險的模型。
  它不是執行工作的 Worker，也不能提高 role ceiling。
- **Supervisor fallback**：Classifier 無法確定時的處理方式。`Deny` 直接拒絕；
  `Wait for supervisor` 讓 Host／使用者進一步判斷。

### Rule 裡每個 keyword 的作用

| Keyword | 它控制什麼 | 例子 |
| --- | --- | --- |
| **Rule** | 一條條件式決策：「符合這些條件時，deny／ask／allow 某 capability」。 | Reviewer 連到特定文件網域時允許 `network.connect`。 |
| **id** | 讓 audit、錯誤訊息與未來編輯能辨識這條 rule；不會改變權限。 | `ask-package-install`。 |
| **effect** | Rule 命中後的結果。`deny` 一定拒絕；`ask` 要求判斷；`allow` 只在其他上限內允許。 | 即使 `allow`，Strict 沒有 Bash 時仍不會得到 Bash。 |
| **capability** | 要控制的權限種類。不是 command 本身。 | `shell.execute` 可涵蓋許多不同 shell command。 |
| **roles** | 只有列出的 Worker 職責會命中；留白代表所有 role。 | 只限制 `reviewer`，不影響 `executor`。 |
| **taskKinds** | 只有指定工作類型會命中；留白代表所有 Job kind。 | 只在 `discover` 生效。 |
| **pathPrefix** | 把 workspace 讀／寫規則縮小到某個相對資料夾。 | `docs/reference`，不是 `/Users/.../docs`。 |
| **domain** | 把 network rule 限定到 exact hostname 或其 subdomain wildcard。 | `docs.example.com` 或 `*.example.com`，不是完整 URL。 |
| **Trusted domain** | Adaptive classifier 可視為預先信任的 outbound hostname；仍不會越過 role、roots 或 secret gate。 | `registry.npmjs.org`。不要填 `https://.../path`。 |
| **Diagnostics** | 保存移除機密後的 classifier 判斷摘要，方便調查為何允許／拒絕。 | 不會保存 API key 或完整 credential。 |

### 六種 capability 的白話意思

| Capability | 允許的類型 | 它不代表什麼 |
| --- | --- | --- |
| `filesystem.read-workspace` | 讀取允許 roots 內的檔案 | 不能寫入，也不代表可讀 workspace 外。 |
| `filesystem.write-workspace` | 在允許 write roots 內新增或修改檔案 | 不包含 `.git`、commit、push 或任意刪除。 |
| `filesystem.write-temp` | 寫入 Job 使用的暫存區 | 不代表可把結果 materialize 回專案。 |
| `git.read` | 查看 status、diff、history 等 Git 資訊 | 不包含 commit、merge、checkout 或 push。 |
| `shell.execute` | 提議執行一個精確 shell command | 不代表所有 command 都安全；每個 fingerprint 仍分開判斷。 |
| `network.connect` | 連到 policy 允許的 hostname | 不代表可傳送 secret、使用 private connector 或連任意 IP。 |

如果你無法明確說出「哪個 role、哪個 task、哪個 path/domain、為什麼要 allow」，
請先不要建立 allow rule。讓 Adaptive 使用 classifier + Wait for supervisor 通常更容易
理解與調查。

### Rule 格式

```json
{
  "id": "allow-docs",
  "effect": "allow",
  "capability": "network.connect",
  "roles": ["scout"],
  "taskKinds": ["ask"],
  "domain": "*.example.test"
}
```

| 屬性 | 可接受值 |
| --- | --- |
| `id` | 唯一、1–64 字元，只能用小寫字母／數字及 `.`, `_`, `-` |
| `effect` | `deny`、`ask`、`allow` |
| `capability` | `filesystem.read-workspace`、`filesystem.write-workspace`、`filesystem.write-temp`、`git.read`、`shell.execute`、`network.connect` |
| `roles` | 選填、非空、不可重複的 canonical Role ID；internal role 是進階但有效值 |
| `taskKinds` | 選填、非空、不可重複的 canonical Job kind |
| `pathPrefix` | 只可搭配 workspace read/write；例如 `docs/reference` 的 canonical relative POSIX path |
| `domain` | 只可搭配 `network.connect`；小寫 exact host 或 `*.` wildcard |

未知屬性會被拒絕。`pathPrefix` 不允許絕對路徑、反斜線、`.`／`..`、traversal、
空 segment 或結尾斜線。`domain` 不允許 URL、port、credential、localhost 或 IP。
一條 rule 不能同時有 path 與 domain selector。表單最多接受 128 條規則，錯誤會
指出 rule 編號或 ID。

Legacy 的無效規則在 tolerant load 時會被略過，避免誤授權；新儲存設定與新 Job
snapshot 一律使用 strict validator。

<a id="workflow-keywords"></a>
## Decision mode 與 Background implementation

### Decision mode

Decision mode 控制 `orchestrate` 的基本唯讀分析深度，不是 Sandbox mode，也不是
auto-approval 等級：

- **Cost**：1 個基本 perspective；較快、模型用量較少。
- **Balance**：2 個基本 perspectives；一般預設。
- **Power**：3 個基本 perspectives；覆蓋較廣，但延遲與用量較高。

它不會改寫 Host Assistance request limit、Advisor quota、roots 或安全 gate。
**Question → Delete → Simplify** 目前只是存入 snapshot 的偏好 metadata；勾選不會
自動啟動一個刪除或簡化流程。

### Background implementation

- **Mechanical executor** 是處理明確、機械式修改的受限 Worker role，不適合需求不明
  或高判斷風險工作。
- **Job-owned worktree** 是為該 Job 建立的隔離 Git working directory。Worker 的修改
  不會直接混入 Host 當前 worktree。
- **Background** 表示 Job 可由 durable worker 執行；不代表 Host 可以忘記它。Host
  仍須處理 approval、progress、terminal notification 與最後驗證。

如果專案不需要長時間的機械式修改，保持關閉即可。開啟也不會授權 commit、push
或 materialization。

<a id="host-assistance"></a>
## Host Assistance

Host Assistance 是 Worker 向 Host 提出請求的通道，不是 Host Actions，也不會單靠
request 自動取得權限。Worker 會提交目的、精確目標、最小必要權限、副作用、
資料暴露、失敗模式、可逆性、rollback、驗證、建議風險與替代方案。活躍 Host
會把這份 assessment 當成不可信建議，獨立比對原始意圖、policy、roots、role
ceiling 與精確 action fingerprint。

### 它解決的是「Worker 缺資訊或卡在判斷」，不是增加永久權限

例子：Reviewer Worker 發現程式使用一個自己不認識的 SDK。

1. Worker 提出 Host Assistance request，說明要確認哪個 API、版本與風險。
2. Host 檢查原始需求是否真的需要這份資料，以及可不可以只查公開官方文件。
3. 若符合 Host-first ceiling，Host 取得文件並把有來源的 context 回傳給同一個
   Worker；不符合時才詢問你。
4. Worker 繼續 review。這個流程沒有給 Worker 一張永久 Web 通行證。

反例：Worker 建議 deploy production。這不是「補充 context」，而是有外部副作用的
delivery；Host Assistance 不會把它變成可自動執行，必須交給你決定。

### Host Assistance keyword

| Keyword | 白話意思 | 如何選 |
| --- | --- | --- |
| **Request** | Worker 卡住時提出的一次結構化求助，有目的、精確目標、風險與 fallback。 | 不是每一次 tool call；只有真的需要 Host 資訊或判斷時才計數。 |
| **Context** | Host 回傳、讓 Worker 繼續推理的資料。它是輸入內容，不是執行權限。 | 官方文件摘要是 context；`network.connect` 是 capability，兩者不同。 |
| **Context class** | Context 的來源類別，用來預先限制 Worker 可以請求哪些資料。 | 不需 private connector 的專案就不要勾 connector。 |
| **Workspace** | 目前專案內、policy roots 允許的檔案內容。 | 不包含任意 workspace 外路徑。 |
| **Public Web** | 不需登入、可公開取得的 Web 內容。 | 不包含私人帳號頁面或付費／內網資料。 |
| **SDK/API docs** | 官方或可信的技術文件。 | 適合確認最新版 API；不是執行 API operation。 |
| **Papers** | 研究論文或技術研究資料。 | 適合 algorithm／method evidence，通常不適合即時產品狀態。 |
| **Private connector** | 需要私人登入或可接觸非公開資料的 connector。 | 建議 Ask each time；Host model 不可自動放行。 |
| **Installed skill** | Host 已安裝、具有專門工作流程的指令包。 | Skill 仍受原始意圖與 policy 限制，不是權限外掛。 |
| **Context allowance** | 單次 Host context request 可以回傳多少文字的具名上限。 | Standard 最多 32,768 字元；不會增加任何 tool capability。 |
| **Requests per Job** | 一個 Job 最多能提出幾次 Host Assistance。 | `4` 代表最多四次求助，不代表四個同時執行的 Worker。 |
| **Fan-out** | 同一時間最多允許幾個未完成 request。 | Requests=4、fan-out=2：總共最多四次，但同時最多兩次。 |
| **Review path** | 誰先判斷 request。 | Host-first 先由活躍 Host model 判斷；User-only 每次直接問你。 |
| **Auto-approval ceiling** | Host model 最多可以自動處理到哪種風險層級，不是保證核准。 | Reversible 仍要求精確目標、原始修改意圖、rollback 與驗證。 |
| **Discovery gate review** | Discovery research／convergence 關卡資料完整時，允許 Host model 先審查。 | 缺 evidence、範圍擴張或信心不足仍會問你。 |
| **WorkerAssessment** | Worker 對需求、風險、可逆性與替代方案的自評。 | Host 把它當不可信建議，必須獨立檢查。 |
| **HostAdjudicationReceipt** | Host 判斷後留下的 audit receipt，記錄理由、限制、fingerprint 與 policy hash。 | 它讓日後知道「誰為什麼核准」，不是萬用權限。 |

### 三種 auto-approval ceiling

- **Context only**：只能自動回傳符合政策的公開／唯讀 context；不核准 tool
  capability 或修改。
- **Read-only capabilities**：除了 context，可核准精確的唯讀動作，例如受限的
  repository inspection；不能修改檔案。
- **Bounded reversible changes**：再允許原始 Job 已有修改意圖、位於 write roots、
  有 rollback 與驗證方法的精確可逆修改。Commit、push、deploy、message、transaction
  與不可逆動作仍不包含在內。

`Ceiling` 的意思是「最高上限」，不是「此範圍全部自動通過」。Host 信心不足時
仍會 fallback 回來詢問你。

| 欄位 | 意義 | 預設／0 的行為 |
| --- | --- | --- |
| Default | 專案設定明確選 On 或 Off | 新專案 On；project UI 不提供 `inherit` |
| Review path | Host-first 或一律詢問使用者 | 新專案 Host-first；缺欄位的 legacy 設定在重新儲存前維持 User-only |
| Auto-approval ceiling | Context-only、Read-only 或 Reversible | 新專案 Reversible；不擴大 Strict 或受保護 gate |
| Discovery gate review | 讓活躍 Host 審查完整且有限的 gate | 新專案開啟 |
| Allowed context classes | Workspace、Web、docs、paper、connector、skill | 只選工作真正需要的最小集合 |
| Context allowance | Off、Compact、Standard、Extended | 預設 Standard；分別為 0、8,192、32,768、64,000 個回傳字元 |
| Requests per Job | `0–6` | 預設 4；0 不允許 request |
| Concurrent fan-out | `0–3`，且不可大於 requests | 預設 2；0 不允許並行 fan-out |
| Private connectors | Deny 或每次詢問 | 預設 ask；Host 永遠不可自動核准 |

Host-first 只能自動處理已在使用者意圖內、符合 ceiling、目標精確且唯讀或可逆的
動作。Secret、受保護 `.git`、workspace 外資源、delivery、commit／push／merge、
publish、deploy、message、transaction、不可逆工作、live service recovery 不明或
信心不足，都必須交給使用者。Hook、replay、watcher、timeout 與背景 recovery 只能
通知，不能核准。

CLI Job override 仍可使用 `inherit`；durable project setup 必須選 On 或 Off。已儲存
的 legacy `inherit` 只會顯示成當下 effective 明確值，單純開啟設定頁不會改寫
storage。

<a id="advisor"></a>
## Advisor

Advisor 會為所選 Job kind 加入有限、唯讀的獨立觀點。它不是動態 coordinator，
不能修改檔案，也不能遞迴呼叫自己。

### Consultation 和 perspective 的差別

- **Consultation** 是「某個 Job 何時向 Advisor 問一次」。例如 plan 做完初稿後，
  請 Advisor 檢查遷移風險，這算一次 consultation。
- **Perspective** 是「這一次 consultation 最多收集幾個彼此獨立的看法」。例如
  security、maintainability、migration 三個角度，最多是三個 perspectives。
- **Target** 是「哪些 Job kind 可以使用 Advisor」。未選 `implement` 就表示
  implementation Job 不會呼叫 Advisor，不是表示 implement 被完全禁止。

因此 Consultations=2、Perspectives=3 的意思是：一個符合 target 的 Job 最多在兩個
時間點詢問 Advisor，每次最多取得三個獨立觀點。它不是保證一定產生六個 model
call；runtime 可以少用，但不能超過上限。

一般建議：普通 implement 保持 Off；跨模組 plan、風險 review、架構 orchestrate 或
未知需求 discover 才考慮開啟。Advisor 只能提供意見，不能自行修改或核准動作。

| 欄位 | 範圍 | 預設 | 填寫建議 |
| --- | --- | --- | --- |
| Enable Advisor | on／off | off | 只有確實需要獨立觀點，且可接受額外延遲／模型用量時才開啟 |
| Advisor targets | canonical Job kinds | review、plan、orchestrate、discover | 只選會受益的工作類型 |
| Consultations per Job | `0–3` | 2 | 一個 Job 最多可提出幾次 Advisor consultation |
| Maximum Advisor perspectives | `0–4` | 3 | 每次 consultation 最多收集幾個獨立觀點 |

0 只在 Advisor 關閉時有效。啟用時至少需要一個 target，而且 consultation 與
perspective 都必須大於 0。

<a id="host-actions"></a>
## Host Actions 0.5

Host Actions 會在隔離 child Job 執行一項明確記錄的 recommendation。在 Host 主動
啟動符合資格的 child 前，recommendation 都保持 inert。

開啟 Host Actions 不會要求 Worker 產生 recommendation，也不會自動啟動任何動作。
只有 `implement` 或 `setup` Worker 主動送出結構化的 `action-recommendation` Host
Assistance request、Host 將它記錄、parent 成功，而且使用者明確確認
`jobs action-start`，這條路徑才會成立。Worker 只在一般輸出文字中寫「建議之後做」
並不算可執行 recommendation；所以目前的觸發條件刻意很窄，實務上也不常出現。

`0.5` 是這個功能目前的成熟度／協定版本標示，不是費用、模型版本或權限等級。

### Host Action keyword

| Keyword | 白話意思 | 例子／限制 |
| --- | --- | --- |
| **Recommendation** | Worker 提出的具體後續動作建議；剛產生時只是一筆 inert 紀錄。 | 「更新本機設定檔並驗證」；不會因為被建議就自動執行。 |
| **Inert** | 已記錄但不會自行造成任何副作用。 | 必須由活躍 Host 明確 start，hook／watcher 不行。 |
| **Child Job** | 為這個 action 新建立的隔離 Job，有自己的狀態與驗證。 | 不會偷偷延續原 Worker 尚未完成的 call stack。 |
| **Action class** | 用來分類副作用種類，讓 policy 能分別允許。 | `local-mutation` 和 `deploy` 的風險完全不同。 |
| **Local mutation** | 只改本機允許範圍內的檔案或狀態。 | 仍不能任意碰 `.git` 或 workspace 外。 |
| **Draft** | 產生尚未對外送出的內容。 | 建立 release note 草稿，不等於 publish。 |
| **Remote write** | 修改遠端服務資料。 | 更新 issue 欄位；需要 remote toggle 且通常仍要使用者確認。 |
| **Message** | 對人或群組送出訊息。 | Email／Slack 等外部溝通永遠不是純草稿。 |
| **Deploy** | 改變可執行環境或 live service 狀態。 | 需要已知 health check、rollback 與中斷風險。 |
| **Transaction** | 產生付款、購買、資產或其他實質交易。 | 不可由 Host model 自動核准。 |
| **Lease** | 綁定 action family、scope、次數與期限的臨時執行票券。 | 改 command／target 後 fingerprint 不同，lease 失效。 |
| **TTL** | Time To Live；lease 從建立到過期的分鐘數。 | `30` 代表 30 分鐘後未使用的權限失效。 |
| **Maximum uses** | 同一 action-family lease 最多能被消耗幾次。 | 建議從 1 開始，不是 Worker retry 次數。 |
| **Recommendation cost value** | 由系統帶進 lease 的非負 metadata，供記錄／政策比較。 | 目前不是新台幣、美元、帳單或強制預算。 |
| **Remote toggle** | 遠端副作用的第二道總開關。 | 只勾 deploy class 但不開 remote toggle，仍不能 deploy。 |

### Host Assistance 與 Host Actions 不一樣

| | Host Assistance | Host Actions |
| --- | --- | --- |
| 目的 | 補資料、請 Host 判斷、解除資訊阻塞 | 執行一筆已記錄的後續 recommendation |
| 回傳 | Context、decision 或受限 approval | 新的 isolated child Job 結果 |
| 是否直接造成副作用 | Request 本身不會 | Child 執行時可能會，所以限制更嚴格 |
| 一般專案建議 | 開啟 Host-first | 保持 Off，確定有 action-broker 需求才開 |

| 欄位 | 意義 |
| --- | --- |
| Enable | 允許符合資格的 isolated child Job，不會自動啟動 |
| Allowed action classes | Local mutation、draft、remote write、message、deploy、transaction |
| Remote toggle | 除了選擇至少一個 remote class 外，還必須明確開啟 |
| Maximum uses | action-family lease 可使用 `1–100` 次 |
| Recommendation cost value | 複製到 lease 的非負 opaque metadata；不是貨幣、計費或強制 spend cap |
| Lease TTL | `1–1440` 分鐘 |

建議以 local mutation／draft、1 次使用與短 TTL 起步。Remote class 不會移除對
受保護 delivery、message、deploy 或 transaction 的使用者確認。

<a id="project-goal"></a>
## Project goal

Goal 是規劃與審查會持續使用的專案背景，不是今天的 ticket、shell command，
也不是自動完成的承諾。

這裡的 **durable／持久** 是指「未來多個 Job 都可以重複使用」，不是「永遠不能
修改」。Project goal 應回答三件事：

1. **Outcome**：完成後要改善什麼？
2. **Audience**：誰會使用或受影響？
3. **Constraints**：哪些品質、安全或技術限制長期都重要？

可以直接使用這個句型：

> 為【使用者／對象】建立【產品或能力】，讓他們可以【預期成果】，同時遵守
> 【重要限制】。

例如：「為內部客服建立可稽核的案件管理工具，讓團隊能追蹤處理狀態，同時避免
未授權存取客戶資料。」今天要修的按鈕、特定 command 或單次 deadline 應放在 Job
request，不要塞進 Project goal。

- 最多 4,000 字元；空白無效。
- 描述預期成果、使用者／對象與重要限制。
- 好範例：「建立具備可稽核存取控制的可靠內部支援工具。」
- 避免：「現在執行這個 command」、憑證、token 或一次性 bug trace。
- 成功儲存只影響未來 Job，不會改寫舊 snapshot。

<a id="working-area"></a>
## Working area

Working area 決定 project policy 的資料夾 roots：

- **Whole project**：以 workspace root `.` 作為範圍。仍會保護 `.git`、runtime state、
  credential 與其他受保護路徑。
- **Selected folders**：只把勾選資料夾放入 roots。這適合 monorepo 或只想讓 Pi
  處理 `docs/`、`packages/app/` 等區域。
- **Read root** 與 **write root** 是不同概念；有些工作可以讀較廣，但只能在明確
  write roots 修改。
- **Workspace** 是這次設定綁定的專案根目錄，不是整台電腦或使用者 home。

選擇資料夾不會把內容複製出去，也不會自動授權 shell。它只是縮小後續 policy
檢查所允許的路徑範圍。

<a id="delegated-work"></a>
## 委派工作 — Additional task types

所選類別是 admission gate，不是 prompt label；這裡沒有自由格式的 task-plugin
欄位。

**Admission gate** 的意思是「Job 啟動前的資格檢查」。勾選某類型表示 Host 可以把
這種工作委派給 Pi；沒有勾選時，runtime 會在模型啟動前拒絕，不會只是提醒模型
「最好不要做」。它也不會因為勾選 implementation 就自動授權 commit、deploy 或
workspace 外寫入；那些仍由 capability、roots 與 delivery gate 控制。

### 每個 task type 實際代表什麼

| 畫面類型 | Canonical Job kind | 適合的需求 | 不適合／不自動包含 |
| --- | --- | --- | --- |
| Implementation | `implement` | 已明確知道要修改哪些功能、bug 或 refactor | 未知需求研究、commit、push、deploy |
| Planning | `plan` | 產生實作步驟、migration 順序與驗收方式 | 實際修改檔案 |
| Code review | `review` | 檢查 working tree／branch 的 bug、security、regression、缺測試 | 自動修正 finding |
| Analysis | `ask`, `orchestrate` | 回答 repository 問題，或從數個唯讀角度分析架構／風險 | 修改檔案或執行 delivery |
| Scaffolding | `scaffold` | 在空資料夾設計新專案，先於隔離 staging 產生內容 | 直接覆寫既有專案或自動 materialize |
| Development setup | `setup` | 設定專案內 build、test、lint、dependency tooling | 全域安裝、production deployment |
| Discovery | `discover` | 需求未知時做 research、可重現 experiment 與 convergence | 把 experiment artifact 直接變成產品程式碼 |

**Alias** 是畫面上較容易理解的別名，例如 `planning`；**canonical Job kind** 是
runtime 內部固定名稱，例如 `plan`。兩者只是命名映射，不代表兩套不同能力。

| UI alias | Canonical Job kind |
| --- | --- |
| `implementation` | `implement` |
| `planning` | `plan` |
| `code-review` | `review` |
| `analysis` | `ask`、`orchestrate` |
| `scaffolding` | `scaffold` |
| `development-setup` | `setup` |
| `discovery` | `discover` |

Service 也接受 canonical Job kind。輸入會 trim、轉小寫，並把空格／underscore
改成 hyphen。只要有任何未知 token 就會明確報錯，即使同一份輸入也包含有效
token。Setup 不接受空集合；policy level 的空集合也代表不允許任何委派工作。

Legacy 未知 label 會繼續顯示為 unsupported，但不授予 capability。只有成功重新
儲存後才會從 durable state 移除；單純開啟或儲存失敗都不會改寫既有 profile。
