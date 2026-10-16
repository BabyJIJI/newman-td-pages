/**
 * Newman Tech Design お問い合わせフォーム受付 Worker
 *
 * POST https://newman-tech-design.com/api/contact
 *   - JSON（サイトの JavaScript から）または通常のフォーム送信を受け付ける
 *   - 入力チェックとスパム対策（ハニーポット・送信までの時間）を行い、
 *     Cloudflare の send_email バインディングで TO_ADDRESS 宛てにメールを送る
 *
 * 必要な設定（wrangler.toml）:
 *   [[send_email]] name = "EMAIL"     … メール送信バインディング
 *   secret TO_ADDRESS                  … 受信先（Email Routing で認証済みのアドレス。ダッシュボードで登録）
 *   vars.FROM_ADDRESS                  … 送信元（newman-tech-design.com のアドレス）
 *   secret TURNSTILE_SECRET（任意）     … 設定するとフォーム側の Turnstile 検証を必須にする
 */

const SITE_ORIGIN = "https://newman-tech-design.com";
const THANKS_PATH = "/contact/thanks/";
const ERROR_PATH = "/contact/?error=1";

const INDUSTRIES = ["飲食店", "小売店", "サロン・教室", "工場・倉庫", "事務所・その他", ""];
const AREAS = ["城陽市", "宇治市", "京田辺市", "八幡市", "久御山町", "京都市", "その他", ""];
const MIN_FILL_MS = 3000; // 表示から3秒未満の送信はボットとみなす

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const origin = request.headers.get("Origin");
    if (origin && origin !== SITE_ORIGIN) return new Response("Forbidden", { status: 403 });

    const contentType = request.headers.get("Content-Type") || "";
    const wantsJson = contentType.includes("application/json");

    let raw;
    try {
      raw = wantsJson ? await request.json() : Object.fromEntries(await request.formData());
    } catch {
      return reply(wantsJson, 400, false, "送信内容を読み取れませんでした。");
    }

    // スパム対策：ハニーポットに入力がある、または入力が速すぎる場合は送ったふりをして終了
    const startedAt = Number(raw.t || 0);
    if (str(raw.website) || !startedAt || Date.now() - startedAt < MIN_FILL_MS) {
      return reply(wantsJson, 200, true, "送信しました。");
    }

    if (env.TURNSTILE_SECRET) {
      const ok = await verifyTurnstile(env.TURNSTILE_SECRET, str(raw["cf-turnstile-response"]),
        request.headers.get("CF-Connecting-IP"));
      if (!ok) return reply(wantsJson, 400, false, "確認に失敗しました。ページを再読み込みしてお試しください。");
    }

    const data = {
      name: oneLine(raw.name, 100),
      company: oneLine(raw.company, 100),
      email: oneLine(raw.email, 254),
      phone: oneLine(raw.phone, 30),
      industry: oneLine(raw.industry, 30),
      area: oneLine(raw.area, 30),
      message: str(raw.message).trim().slice(0, 4000),
      consent: raw.consent === true || raw.consent === "on" || raw.consent === "true",
    };

    const errors = [];
    if (!data.name) errors.push("お名前");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push("メールアドレス");
    if (data.phone && !/^[0-9+\-() ]{6,30}$/.test(data.phone)) errors.push("電話番号");
    if (!INDUSTRIES.includes(data.industry)) errors.push("業種");
    if (!AREAS.includes(data.area)) errors.push("地域");
    if (data.message.length < 5) errors.push("ご相談内容");
    if (!data.consent) errors.push("プライバシーポリシーへの同意");
    if (errors.length) {
      return reply(wantsJson, 400, false, `入力内容をご確認ください（${errors.join("、")}）。`);
    }

    const text = [
      "ホームページのお問い合わせフォームから送信がありました。",
      "",
      `お名前　　　：${data.name}`,
      `会社名・屋号：${data.company || "（未入力）"}`,
      `メール　　　：${data.email}`,
      `電話番号　　：${data.phone || "（未入力）"}`,
      `業種　　　　：${data.industry || "（未選択）"}`,
      `地域　　　　：${data.area || "（未選択）"}`,
      "",
      "■ ご相談内容",
      data.message,
      "",
      "---",
      `受付日時：${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
      "このメールに返信すると、お問い合わせいただいた方に届きます。",
    ].join("\n");

    if (!env.TO_ADDRESS) {
      console.error("TO_ADDRESS is not set");
      return reply(wantsJson, 500, false, "送信に失敗しました。時間をおいて再度お試しいただくか、メールでご連絡ください。");
    }

    try {
      await env.EMAIL.send({
        to: env.TO_ADDRESS,
        from: { email: env.FROM_ADDRESS, name: "Newman Tech Design お問い合わせ" },
        replyTo: { email: data.email, name: data.name },
        subject: `【お問い合わせ】${data.company || data.name} 様`,
        text,
      });
    } catch (err) {
      console.error("send failed", err && err.code, err && err.message);
      return reply(wantsJson, 502, false, "送信に失敗しました。時間をおいて再度お試しいただくか、メールでご連絡ください。");
    }

    return reply(wantsJson, 200, true, "送信しました。");
  },
};

function str(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// 1行項目：改行を除去して長さを制限（メールヘッダーへの差し込み対策）
function oneLine(v, max) {
  return str(v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function cors() {
  return {
    "Access-Control-Allow-Origin": SITE_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function reply(wantsJson, status, ok, message) {
  if (wantsJson) {
    return new Response(JSON.stringify({ ok, message }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
    });
  }
  // JavaScript なしの通常送信は、完了ページかフォームへ戻す
  return Response.redirect(SITE_ORIGIN + (ok ? THANKS_PATH : ERROR_PATH), 303);
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const out = await res.json().catch(() => ({}));
  return out.success === true;
}
