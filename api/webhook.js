console.log('ENV CHECK', {
  hasOpenAI: !!process.env.OPENAI_API_KEY,
  hasSecret: !!process.env.LINE_CHANNEL_SECRET,
  hasToken: !!process.env.LINE_CHANNEL_ACCESS_TOKEN
});

import crypto from 'crypto';
import OpenAI from 'openai';

// ---- 讀環境變數（在 Vercel 建立）----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 驗證 LINE 簽章（HMAC-SHA256 / base64）
function verifyLineSignature(rawBody, signature) {
  const hmac = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hmac === signature;
}

// 回覆訊息
async function lineReply(replyToken, text) {
  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error('LINE reply error:', resp.status, t);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 收集 raw body（Buffer）
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', (c) => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];

    // 簽章驗證
    if (!verifyLineSignature(rawBody, signature)) {
      console.warn('Invalid LINE signature');
      return res.status(403).send('Forbidden');
    }

    // 先回 200，避免 LINE 判定逾時
    res.status(200).end();

    const body = JSON.parse(rawBody.toString('utf8'));
    const events = body.events || [];

    for (const event of events) {
      if (event.type === 'message' && event.message?.type === 'text') {
        const userText = (event.message.text || '').trim();

        let aiText = '（暫時無法回覆）';
        try {
          const resp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: '你是用繁體中文回覆的貼心助理。'
              },
              {
                role: 'user',
                content: userText
              }
            ],
            max_tokens: 1000,
            temperature: 0.7
          });
          aiText = (resp.choices[0].message.content || '（沒有內容）').slice(0, 1900); // 保守避免超過 LINE 單則長度
        } catch (e) {
          console.error('OpenAI error:', e);
          aiText = '我這邊忙線一下，請稍後再試。';
        }

        await lineReply(event.replyToken, aiText);
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    // 若還沒回過狀態碼才回
    if (!res.headersSent) return res.status(500).send('Internal Server Error');
  }
}
import crypto from 'crypto';
import OpenAI from 'openai';

// ---- 讀環境變數（在 Vercel 建立）----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 驗證 LINE 簽章（HMAC-SHA256 / base64）
function verifyLineSignature(rawBody, signature) {
  const hmac = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  return hmac === signature;
}

// 回覆訊息
async function lineReply(replyToken, text) {
  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error('LINE reply error:', resp.status, t);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 收集 raw body（Buffer）
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', (c) => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];

    // 簽章驗證
    if (!verifyLineSignature(rawBody, signature)) {
      console.warn('Invalid LINE signature');
      return res.status(403).send('Forbidden');
    }

    // 先回 200，避免 LINE 判定逾時
    res.status(200).end();

    const body = JSON.parse(rawBody.toString('utf8'));
    const events = body.events || [];

    for (const event of events) {
      if (event.type === 'message' && event.message?.type === 'text') {
        const userText = (event.message.text || '').trim();

        let aiText = '（暫時無法回覆）';
        try {
          const resp = await openai.responses.create({
            model: 'gpt-4o-mini',
            instructions: '你是用繁體中文回覆的貼心助理。',
            input: userText
          });
          aiText = (resp.output_text || '（沒有內容）').slice(0, 1900); // 保守避免超過 LINE 單則長度
        } catch (e) {
          console.error('OpenAI error:', e);
          aiText = '我這邊忙線一下，請稍後再試。';
        }

        await lineReply(event.replyToken, aiText);
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    // 若還沒回過狀態碼才回
    if (!res.headersSent) return res.status(500).send('Internal Server Error');
  }
}
