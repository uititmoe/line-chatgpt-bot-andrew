# LINE × ChatGPT Bot (Vercel)

## 環境變數（在 Vercel 專案 Settings → Environment Variables 新增）
- OPENAI_API_KEY
- LINE_CHANNEL_SECRET
- LINE_CHANNEL_ACCESS_TOKEN

## 路徑
- 健康檢查: `/api/health`
- LINE Webhook: `/api/webhook`

## 部署流程
1. 將此專案推到 GitHub。
2. 到 Vercel → Import Project → 選你的 GitHub repo → Deploy。
3. 在 Vercel 專案 → Settings → Environment Variables 新增三個變數（上面列的 Key，Value 對應你的金鑰）。
4. 點「Redeploy」套用環境變數。
5. 複製你的 Vercel 網域，LINE Developers → Messaging API → Webhook URL 填入：

```
https://<your-vercel-domain>/api/webhook
```

按 Verify → 打開 **Use webhook**。
6. 把官方帳號加好友，傳訊測試。

## 常見問題
- 403 Invalid signature：Vercel 要用 raw body 驗證；本專案已自行收集原始 body。
- 回覆失敗：檢查 `LINE_CHANNEL_ACCESS_TOKEN` 是否正確，及 Reply API 限制。
- 沒回覆或過慢：OpenAI 回覆逾時時，會回覆一則友善訊息。
