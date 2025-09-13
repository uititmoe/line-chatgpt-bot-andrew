import { createHmac } from 'node:crypto';
import OpenAI from 'openai';

const { LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, OPENAI_API_KEY } = process.env;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 驗證 LINE 簽章
function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hmac === signature;
}

// 呼叫 LINE Reply API
async function lineReply(replyToken, text) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const body = JSON.stringify({
    replyToken,
    messages: [{ type: 'text', text }]
  });
  const headers = {
    'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };

  console.log('[LINE REPLY] Request', body);

  const resp = await fetch(url, { method: 'POST', headers, body });
  const respText = await resp.text();
  console.log('[LINE REPLY] Response', { status: resp.status, text: respText });

  return resp.ok;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 收 raw body
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];

    if (!verifyLineSignature(rawBody, signature)) {
      console.warn('[SIGNATURE] 驗證失敗');
      return res.status(403).send('Invalid signature');
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    console.log('[INCOMING BODY]', JSON.stringify(body));

// 讀取環境變數
const SYSTEM_MESSAGE = process.env.SYSTEM_MESSAGE;

// 處理事件
for (const event of body.events || []) {
  if (event.type === 'message' && event.message?.type === 'text') {
    const userText = event.message.text.trim();
    let aiText = '我這邊忙線一下，等等再試。';

    try {
      const r = await openai.responses.create({
        model: 'gpt-4o-mini',
        instructions: SYSTEM_MESSAGE || '你是一個用繁體中文回覆的貼心助理。',
        input: userText
      });
      aiText = (r.output_text || '').slice(0, 1900); // LINE 單則訊息限制
    } catch (e) {
      console.error('[OpenAI ERROR]', e);
    }

    await lineReply(event.replyToken, aiText);
  }
}

    // 確定處理完才回 200
    res.status(200).end();
  } catch (e) {
    console.error('[WEBHOOK ERROR]', e);
    if (!res.headersSent) res.status(500).end();
  }
}
