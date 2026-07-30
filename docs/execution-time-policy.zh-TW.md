# 執行時間與復原

Swarm Pi 0.23 將**失聯復原**與**絕對 active-time 上限**分開；不會依模型名稱或大小
猜測執行期限。

新 Job 預設為：`ask`、`plan`、`review` 1 小時；`implement`、`setup`、`scaffold`
4 小時；`discover`、`orchestrate` 8 小時。Configuration 可選 1、4、8、12 小時。
這是參考公開觀測後制定的產品政策，不是供應商 SLA；既有保存 12–24 小時期限的
snapshot 仍照原本期限執行。

`--hard-run-limit-ms` 是正式 CLI；`--timeout-ms` 在 0.23 為 deprecated alias。
`--wait-timeout-ms` 只限制 Host 等待，絕不停止 Job。

## 四種獨立訊號

1. 15 秒 worker heartbeat 只證明程序存在。
2. Trusted progress 是 stream/thinking delta、tool transition、retry、compaction
   或 child Job transition。
3. Liveness probe 檢查既有 session、transport、active tool、process group 與可用的
   provider status；絕不送出第二個 LLM prompt。
4. Hard limit 不受其他訊號影響，到期即終止 active work。

閒置五分鐘後每分鐘探測一次，response deadline 為 10 秒。連續三次失敗後進入
10 分鐘 recovery grace，再做最後確認。可連線但沒有進度只標示
`suspected-stalled`。確定失聯的相容狀態仍是 `timed-out`，原因為
`unresponsive-timeout`；絕對上限原因為 `hard-limit-exceeded`。

Active time 包含 provider、queue、tool、retry/backoff、compaction 與 child work；
明確 approval、Host Assistance、Human Decision 等待會暫停計時。Resume 不會重設已
消耗時間；child node 只可取得 parent 剩餘預算。中止後 partial evidence、telemetry 與
audit record 仍可讀取。

請同時參閱 [Configuration](configuration.md) 與 [Architecture](architecture.md)。
