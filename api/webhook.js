import { createHmac } from "node:crypto";
import OpenAI from "openai";

const { 
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  OPENAI_API_KEY,
  SYSTEM_MESSAGE,
  SHEET_WEBHOOK_URL } =
  process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -----------------------------
// 驗證 LINE 簽章
// -----------------------------
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac("sha256", LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  return hmac === signature;
}

// -----------------------------
// LINE Reply
// -----------------------------
async function lineReply(replyToken, text) {
  const url = "https://api.line.me/v2/bot/message/reply";
  const body = JSON.stringify({
    replyToken,
    messages: [{ type: "text", text }],
  });
  const headers = {
    Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  console.log("[LINE REPLY] Request", body);

  const resp = await fetch(url, { method: "POST", headers, body });
  const respText = await resp.text();
  console.log("[LINE REPLY] Response", { status: resp.status, text: respText });

  return resp.ok;
}

// -----------------------------
// 全域暫存（記錄、對話歷史）
// -----------------------------
let logs = [];
let chatHistory = []; //對話延續暫存

// -----------------------------
// 工具：時間處理
// -----------------------------
// 取得現在（台灣）顯示字串
function nowTaipeiDisplay() {
  return new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
}
// 取得現在（UTC ISO，用來精準比對/篩選）
function nowUtcISO() {
  return new Date().toISOString();
}

/** 解析補記用時間：
 *  - 支援：昨天 / 前天 / 明天、mm/dd 或 mm-dd、HH:MM、H點半
 *  - 若含「約 / 大約」且無日期 → 原樣回傳（不轉日時）
 *  回傳：{ display: string, iso: string|null }
 */
function parseDateTimeDetailed(text) {
  const now = new Date();
  // 以台灣日期為基準換算
  const tzOffset = 8 * 60;
  const taiwanNow = new Date(
    now.getTime() + (tzOffset - now.getTimezoneOffset()) * 60000
  );

  // 模糊時間：直接保留原樣（例如「約19:00-21:00」）
  if (/約|大約/.test(text)) {
    const approx = text.match(/約.*$/)?.[0] || text;
    return { display: approx, iso: null };
  }

  // 設定基準年月日
  let y = taiwanNow.getFullYear();
  let m = taiwanNow.getMonth() + 1;
  let d = taiwanNow.getDate();
  let hadDate = false;

  if (/前天/.test(text)) {
    const t = new Date(taiwanNow);
    t.setDate(t.getDate() - 2);
    y = t.getFullYear();
    m = t.getMonth() + 1;
    d = t.getDate();
    hadDate = true;
  } else if (/昨天/.test(text)) {
    const t = new Date(taiwanNow);
    t.setDate(t.getDate() - 1);
    y = t.getFullYear();
    m = t.getMonth() + 1;
    d = t.getDate();
    hadDate = true;
  } else if (/明天/.test(text)) {
    const t = new Date(taiwanNow);
    t.setDate(t.getDate() + 1);
    y = t.getFullYear();
    m = t.getMonth() + 1;
    d = t.getDate();
    hadDate = true;
  }

  const md = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (md) {
    m = parseInt(md[1], 10);
    d = parseInt(md[2], 10);
    hadDate = true;
  }

  // 時間
  let hh = 0;
  let mm = 0;
  const hm = text.match(/(\d{1,2})(?:[:點](\d{1,2})?)/);
  if (hm) {
    hh = parseInt(hm[1], 10);
    if (hm[2]) {
      mm = parseInt(hm[2], 10);
    } else if (text.includes("半")) {
      mm = 30;
    }
  }

  // 沒法判斷日期 → 保留原樣
  if (!hadDate) {
    return { display: text.trim(), iso: null };
  }

  // 轉成 UTC ISO（把台灣當地時間轉成 UTC 時刻）
  const utcMs = Date.UTC(y, m - 1, d, hh - 8, mm, 0);
  const iso = new Date(utcMs).toISOString();

  // 顯示字串（避免重複 +8）
  const display = `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(
    2,
    "0"
  )} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

  return { display, iso };
}

// -----------------------------
// Google Sheet 同步
// -----------------------------
async function syncToSheet(log) {
  if (!SHEET_WEBHOOK_URL) return;
  try {
    await fetch(SHEET_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(log),
    });
  } catch (e) {
    console.error("[Google Sheet 同步失敗]", e);
  }
}

// -----------------------------
// 訊息判斷
// -----------------------------
function isBacklogMessage(text) {
  return /^補記/.test(text.trim());
}
function isSummaryRequest(text) {
  return text.includes("總結"); 
}
function isUndoRequest(text) {
  return text.includes("撤銷") || text.includes("刪除上一則");
}

function isLogCandidate(text) {
  const nonLogPhrases = [
    "我覺得", "我希望", "我猜", "我認為", 
    "可以幫", "能不能", "要不要", "是不是" , "你" 
  ];
    // 非記錄語氣 → 一律當對話
  if (nonLogPhrases.some(p => text.startsWith(p) || text.includes(p))) {
    return false;
  }  
  // 問句排除
  if (/[嗎\?？]$/.test(text)) return false;
  if (isBacklogMessage(text) || isSummaryRequest(text) || isUndoRequest(text))
    return false;

  // 常見日誌動詞
  const verbs = [
    "起床", "出門", "到", "回", "吃", "喝", "買", "畫", "寫", "處理", "做", "打掃", "清理", "看", "睡", "休息", "洗", "完成", "準備",
  ];
  if (verbs.some((v) => text.includes(v))) return true;

  // 常見狀態語氣
  if (/^我/.test(text) || text.includes("正在") || text.includes("剛"))
  return true;
  return false;
}

// -----------------------------
// 分類（含藝廊 & 辦公室的 keyword 判斷）
// -----------------------------
const galleryKeywords = ["藝廊", "展覽", "展場", "佈展", "撤展", "策展", "會計", "收據", "做網站", "架網站", "朝朝", "陸角銀", "講座", "顧展", "收展", "展品", "藝術家", "寄賣", "分潤", "對帳"];
const officeActions = ["打掃", "清理", "整理", "收納", "維護", "修繕", "補貨", "檢查"];

async function classifyStateLog(text) {
  try {
    if (galleryKeywords.some((kw) => text.includes(kw))) {
      return { main: ["A. 藝廊工作"], tags: ["🧾 行政"] };
    }
    if ((text.includes("辦公室") && officeActions.some((kw) => text.includes(kw))) || text.includes("洗衣店")) {
      return { main: ["E. 辦公室維運"], tags: ["🧹 環境整理"] };
    }

    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `你是日誌分類助理。
請把輸入訊息分成：
1. 主模組（五選一：A. 藝廊工作, B. Podcast, C. 商業漫畫, D. 同人與委託, E. 辦公室維運, F. 生活日常）
2. 輔助分類（可多選：創作／交通／行政／財務／SNS／飲食／健康／社交／休息／其他）
只回 JSON，例如：
{"main":["C. 商業漫畫"], "tags":["📢 SNS／宣傳","🧾 行政"]}`,
        },
        { role: "user", content: text },
      ],
    });

    return JSON.parse(r.choices[0].message.content.trim());
  } catch (e) {
    console.error("[GPT 分類錯誤]", e);
    return { main: ["F. 生活日常"], tags: ["📝 其他"] };
  }
}

// -----------------------------
// 摘要 + 小語
// -----------------------------
/** 摘要 */
async function summarizeEvent(text) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "將輸入壓縮成不超過15字的事件描述，去掉贅字語氣詞，語氣自然，不要加句號。" },
        { role: "user", content: text },
      ],
    });
    let s = r.choices[0].message.content.trim();
    s = s.replace(/[。！？、,.]$/, ""); // 去尾標點
    return s;
  } catch (e) {
    console.error("[GPT 摘要錯誤]", e);
    return text;
  }
}

/** 小語（SYSTEM_MESSAGE + 規則混合版；支援補記語氣） */
async function generateShortPhrase(text, isBacklog = false) {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.7,
      max_tokens: 50,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_MESSAGE || "你是熟悉 Jean 的助理"}

任務指令：
請根據輸入內容生成一句不超過 50 字的短語。

規則：
- 即時紀錄 → 用現在進行式，像陪伴聊天。
- 補記 → 用已完成/回顧語氣，避免「正在、準備」。
- 語氣自然，像熟人，輕鬆幽默即可。
- 可以有簡單鼓勵、心情回應、提醒或小知識。
- 避免浮誇、網路流行語。
- 句尾保持自然標點（句號、驚嘆號、問號均可），偶爾可使用表情符號。
- 短語長度可在 10–50 字之間變化。
- 句型保持多樣化，不要每次都以相同字詞（如「開始」「準備」）開頭。
- 可以偶爾加入隱性的情緒或效果描述（例如「空間清爽多了」「看來會很忙碌」）。`,
        },
        {
          role: "user",
          content: isBacklog
            ? `這是一則補記：${text}`
            : `這是一則即時紀錄：${text}`
        }
      ]
    });
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error("[短語生成錯誤]", e);
    return "（狀態已記錄）";
  }
}

// -----------------------------
// 總結日期範圍
// -----------------------------
function getDateRange(type) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (type === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (type === "week") {
    const day = now.getDay() || 7;
    start.setDate(now.getDate() - day + 1);
    start.setHours(0, 0, 0, 0);
    end.setDate(start.getDate() + 7);
    end.setHours(0, 0, 0, 0);
  } else if (type === "month") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(start.getMonth() + 1, 1);
    end.setHours(0, 0, 0, 0);
  }
  return { start, end };
}

// -----------------------------
// Webhook handler
// -----------------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // 收 raw body
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on("data", (c) => chunks.push(c));
      req.on("end", resolve);
      req.on("error", reject);
    });
    const rawBody = Buffer.concat(chunks);
    const body = JSON.parse(rawBody.toString("utf8"));

    const signature = req.headers["x-line-signature"];
    if (!verifyLineSignature(rawBody, signature)) {
      console.warn("[SIGNATURE] 驗證失敗");
      return res.status(403).send("Invalid signature");
    }

    console.log("[INCOMING BODY]", JSON.stringify(body));

    for (const event of body.events || []) {
      if (event.type === "message" && event.message?.type === "text") {
        const userText = event.message.text.trim();
        let aiText = "";

        /** 1.撤銷處理 */
        if (isUndoRequest(userText)) {
          let targetLog = null;
        
          // 嘗試解析「撤銷 <時間字串>」
        const parts = userText.split(" ");
        if (parts.length > 1) {
          const targetTime = parts[1].trim();
          targetLog = logs.find(
            (log) =>
              log.timeISO === targetTime ||
              log.timeDisplay === targetTime
          );
        }
        
        // 如果沒指定時間 → fallback 成撤銷最後一筆
        if (!targetLog && logs.length > 0) {
          targetLog = logs.pop(); // ← 注意這裡是直接移除最後一筆
        }
        
        if (targetLog) {
          // 如果是指定時間找到的 → 軟刪除，避免打亂順序
          if (targetLog && !userText.includes("上一則") && parts.length > 1) {
            targetLog.deleted = true;
          }
          
          try {
            await fetch(process.env.SHEET_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "delete",
                timeISO: targetLog.timeISO,
                timeDisplay: targetLog.timeDisplay,
              }),
            });
          } catch (e) {
            console.error("[Google Sheet 撤銷錯誤]", e);
          }
          
          aiText = `↩️ 已撤銷紀錄：${targetLog.timeDisplay || ""}｜${
            targetLog.summary || "(無摘要)"
          }`;
        } else {
          aiText = "⚠️ 沒有可撤銷的紀錄";
        }
      }          
        /** 2.補記 */
        else if (isBacklogMessage(userText)) {
          const content = userText.replace(/^補記[:：]?\s*/, "");
          const t = parseDateTimeDetailed(content);

          const category = await classifyStateLog(content);
          const summary = await summarizeEvent(content);
          const shortPhrase = await generateShortPhrase(content, true);

          const logItem = {
            type: "backlog",
            timeISO: t.iso || nowUtcISO(),
            timeDisplay: t.display,
            summary,
            main: category.main,
            tags: category.tags,
          };
          logs.push(logItem);
          await syncToSheet(logItem);

          aiText = `📝 補記：${logItem.timeDisplay}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;
        }          
        
        /** 3.即時紀錄 */
        else if (isLogCandidate(userText)) {
          const category = await classifyStateLog(userText);
          const summary = await summarizeEvent(userText);
          const shortPhrase = await generateShortPhrase(userText, false);

          const logItem = {
            type: "instant",
            timeISO: nowUtcISO(),
            timeDisplay: nowTaipeiDisplay(),
            summary,
            main: category.main,
            tags: category.tags,
          };
          logs.push(logItem);
          await syncToSheet(logItem);

          aiText = `🕰️ 已記錄：${logItem.timeDisplay}\n📌 狀態：${summary}\n📂 主模組：${category.main.join(" + ") || "無"}\n🏷️ 輔助：${category.tags.join(" + ") || "無"}\n\n${shortPhrase}`;
        }

        /** 4.總結 */
        else if (isSummaryRequest(userText)) {
          let rangeType = "today";// 預設今天
          let customDate = null;
          
          // 判斷週/月
          if (userText.includes("週")) rangeType = "week";
          if (userText.includes("月")) rangeType = "month";
          
          const { start, end } = getDateRange(rangeType);
          // 判斷日期格式（mm/dd 或 mm-dd）
          const md = userText.match(/(\d{1,2})[\/\-](\d{1,2})/);
          if (md) {
            const now = new Date();
            const y = now.getFullYear();
            const m = parseInt(md[1], 10) - 1;
            const d = parseInt(md[2], 10);
            customDate = new Date(y, m, d);
          }
          
          // 決定範圍
          let start, end;
          if (customDate) {
            start = new Date(customDate.setHours(0, 0, 0, 0));
            end = new Date(customDate.setHours(23, 59, 59, 999));
          } else {
            const range = getDateRange(rangeType);
            start = range.start;
            end = range.end;
          }
          
          // 篩選 logs（跳過沒有 ISO 的或被撤銷的）
          const rangeLogs = logs.filter((log) => {
            if (log.timeISO) {
              const t = new Date(log.timeISO);
              return t >= start && t <= end;
            }
            return false;
          });        
          
          // 標題
          const title =
            rangeType === "custom" && customDate
               ? `${customDate.getMonth() + 1}/${customDate.getDate()} 單日總結` 
               : rangeType === "today"
               ? "今日總結"
               : rangeType === "week"
               ? "本週總結"
               : "本月總結";

          if (rangeLogs.length === 0) {
            aiText = `📊 ${title}\n（沒有紀錄）`;
          } else {
            // 清單
            const list = rangeLogs.map((log, i) =>
              `${i + 1}. ${log.timeDisplay}｜${log.summary}｜${log.main.join(" + ")}｜${log.tags.join(" + ") || "無"}`
          );
            
          // 主模組統計
          const stats = {};
          rangeLogs.forEach((log) =>
          log.main.forEach((m) => (stats[m] = (stats[m] || 0) + 1))
          );
          const statLines = Object.entries(stats).map(
          ([k, v]) => `${k}: ${v} 筆`
          );

          aiText = `📊 ${
          customDate
            ? `${md[1]}/${md[2]} 單日總結`
            : rangeType === "today"
            ? "今日總結"
            : rangeType === "week"
            ? "本週總結"
            : "本月總結"
          }\n\n${list.join("\n")}\n\n📈 主模組統計：\n${statLines.join("\n")}`;
          }

        /** 5.一般對話 */
       else {
         try {
           // 保存使用者訊息
           chatHistory.push({ role: "user", content: userText });

           // 只取最後 5 則對話
           const recentHistory = chatHistory.slice(-5);

           const r = await openai.chat.completions.create({
             model: "gpt-4o",
             messages: [
               {
                 role: "system",
                 content:
                   SYSTEM_MESSAGE || "你是 Jean 的 LINE 助理，用繁體中文自然回應。",
              },
               ...recentHistory,
             ],
           });

           const replyText = (r.choices[0]?.message?.content || "").trim();

           // 保存助理回覆
           chatHistory.push({ role: "assistant", content: replyText });

           aiText = replyText.slice(0, 1900); // 確保不超過 LINE 限制
         } catch (e) {
           console.error("[OpenAI 對話錯誤]", e);
           aiText = "我這邊忙線一下，等等再試。";
         }
       }


        await lineReply(event.replyToken, aiText);
      }
    }

    res.status(200).end();
  } catch (e) {
    console.error("[WEBHOOK ERROR]", e);
    if (!res.headersSent) res.status(500).end();
  }
}
