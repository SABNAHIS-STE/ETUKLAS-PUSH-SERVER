/**
 * E-TUKLAS / SABNAHIS STE PORTAL — PUSH + NOTIFICATION BACKEND v3
 * ---------------------------------------------------------------------------
 * Rewritten for the Firebase → Supabase migration. Replaces:
 *   - firebase-admin / Firestore              -> @supabase/supabase-js
 *   - FCM (Android/Chrome push)                -> removed (see note below)
 *   - Firestore onSnapshot watchers            -> removed (see note below)
 *
 * WHY FCM IS GONE: compat-shim.js's messaging.getToken() always resolves
 * null now, so the client's own `if (token) ... else tryNativePush()`
 * fallback runs unconditionally on every platform — nothing has registered
 * an fcmToken since the migration. It was dead weight, not a bug to fix.
 *
 * WHY THE onSnapshot WATCHERS ARE GONE: they watched Firestore, which stopped
 * receiving writes once the app moved to Supabase — that's the root reason
 * push notifications appeared to stop working. Rather than re-implement
 * them as Supabase Realtime watchers (fragile on a free-tier server that
 * can sleep, and this app already calls the right code at the right time),
 * push now fires synchronously from the same request that creates the
 * notification:
 *   - Grading (submitTeacherFeedback) and any other cross-user notification
 *     -> POST /notifications -> writes user_notifications row + sends push,
 *     in one request, no watcher needed.
 *   - Announcements already have their own working push path: the client
 *     calls the `send-push` Supabase Edge Function directly on creation.
 *     Do NOT also watch the announcements table here — that would send
 *     every announcement push twice.
 *
 * REQUIRED ENV VARS:
 *   SUPABASE_URL               e.g. https://fbzcztctelidztwjhkea.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  Project Settings > API > service_role (secret)
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   (unchanged from before)
 *   RENDER_EXTERNAL_URL        (unchanged — keep-alive ping)
 *
 * REMOVE:  FIREBASE_SERVICE_ACCOUNT (no longer used)
 *
 * npm install @supabase/supabase-js web-push express
 * npm uninstall firebase-admin   (optional cleanup, not required to work)
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const webpush = require('web-push');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

/* ── CORS ─────────────────────────────────────────────────────
 * The frontend (GitHub Pages) calls this server directly from the
 * browser now, cross-origin — the old Firestore-watcher design never
 * needed this since nothing called into the server from the client.  */
const ALLOWED_ORIGIN = 'https://sabnahis-ste.github.io';
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ── SUPABASE ADMIN ──────────────────────────────────────────── */
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[E-Tuklas] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
console.log('[E-Tuklas] Supabase admin client connected ✓');

/* ── WEB PUSH (VAPID) ────────────────────────────────────────── */
webpush.setVapidDetails(
  'mailto:admin@sabnahis.edu.ph',
  process.env.VAPID_PUBLIC_KEY  || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

/* ── AUTH: verify the caller's Supabase JWT ─────────────────────
 * The frontend sends the logged-in user's access token as a normal
 * Bearer header (see API._pushServerAuthHeader in app.html).          */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' });

  req.callerUid = data.user.id;
  next();
}

/* ── HELPERS ─────────────────────────────────────────────────── */

// Matches compat-shim's physicalId() convention for root-level docs
// getting a subcollection row: "<parentUid>::<uuid>"
function makeRowId(uid) {
  return `${uid}::${crypto.randomUUID()}`;
}

function buildNotifData({ type, title, body, link }) {
  if (!type || !title) throw Object.assign(new Error('type and title are required'), { status: 400 });
  return {
    type,
    title,
    body: body || '',
    link: link || null,
    createdAt: new Date().toISOString(),
    read: false
  };
}

// Reads a user's row from the `users` table. Note: this app's tables
// store Firestore-style fields inside a `data` jsonb column (see
// compat-shim.js TABLE_MAP / rpcMutate) — there are no flat columns
// like `grade` or `webpush_subscription`, everything is data->>field.
async function getUser(uid) {
  const { data, error } = await sb.from('users').select('id,data').eq('id', uid).maybeSingle();
  if (error) throw error;
  return data;
}

// Sends a Web Push notification to one user's registered subscription.
// Best-effort: failures are logged, never thrown — a push failure must
// never fail the notification-creation request itself.
async function sendPushToUser(uid, { title, body, type }) {
  try {
    const user = await getUser(uid);
    const rawSub = user && user.data && user.data.webpushSubscription;
    if (!rawSub) return; // user has no push subscription registered — fine, in-app bell still got the row

    const sub = typeof rawSub === 'string' ? JSON.parse(rawSub) : rawSub;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.auth || !sub.keys.p256dh) {
      console.warn(`[WebPush] Skipping ${uid} — subscription missing encryption keys (needs to re-open app)`);
      return;
    }
    if (!process.env.VAPID_PRIVATE_KEY) return;

    await webpush.sendNotification(sub, JSON.stringify({ title, body, tag: type || 'etuklas-notif' }));
  } catch (e) {
    console.warn(`[WebPush] Send failed for ${uid}:`, e.message);
  }
}

/* ── ROUTES: notifications (bell row + push, one call) ──────────
 * These replace the direct-to-Supabase writes that RLS correctly blocks
 * client-side (a user can't insert a notification row for another uid).
 */

// POST /notifications  { uid, type, title, body?, link? }
app.post('/notifications', requireAuth, async (req, res) => {
  try {
    const { uid, type, title, body, link } = req.body || {};
    if (!uid) return res.status(400).json({ error: 'uid is required' });

    const data = buildNotifData({ type, title, body, link });
    const { error } = await sb.from('user_notifications').insert({ id: makeRowId(uid), parent_id: uid, data });
    if (error) throw error;

    sendPushToUser(uid, data); // fire-and-forget, doesn't block the response
    res.json({ ok: true });
  } catch (e) {
    console.error('[E-Tuklas] POST /notifications failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /notifications/batch  { uids: [...], type, title, body?, link? }
app.post('/notifications/batch', requireAuth, async (req, res) => {
  try {
    const { uids, type, title, body, link } = req.body || {};
    if (!Array.isArray(uids) || uids.length === 0) {
      return res.status(400).json({ error: 'uids must be a non-empty array' });
    }

    const data = buildNotifData({ type, title, body, link });
    const rows = uids.map((uid) => ({ id: makeRowId(uid), parent_id: uid, data }));

    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await sb.from('user_notifications').insert(rows.slice(i, i + 400));
      if (error) throw error;
    }

    uids.forEach((uid) => sendPushToUser(uid, data));
    res.json({ ok: true, count: uids.length });
  } catch (e) {
    console.error('[E-Tuklas] POST /notifications/batch failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ── MISC ROUTES ─────────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'running', service: 'E-Tuklas Push Server', time: new Date().toISOString() });
});

app.post('/send-test', requireAuth, async (req, res) => {
  try {
    await sendPushToUser(req.callerUid, { title: '🔔 Test', body: 'E-Tuklas push notifications are working!', type: 'test' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── KEEP ALIVE ──────────────────────────────────────────────── */
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
if (RENDER_URL) {
  setInterval(() => {
    require('https').get(RENDER_URL, () => console.log('[Keep-Alive] Ping ✓'))
      .on('error', (e) => console.warn('[Keep-Alive] Failed:', e.message));
  }, 14 * 60 * 1000);
  console.log('[Keep-Alive] Auto-ping enabled ✓');
}

/* ── START ───────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[E-Tuklas] Push server on port ${PORT} ✓`);
});
