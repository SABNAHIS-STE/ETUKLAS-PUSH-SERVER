/**
 * E-TUKLAS STE PORTAL — PUSH NOTIFICATION BACKEND v2
 * Supports both FCM (Android) and Native Web Push (iOS Safari PWA)
 */

const express  = require('express');
const admin    = require('firebase-admin');
const webpush  = require('web-push');
const app      = express();
app.use(express.json());

/* ── FIREBASE ADMIN ─────────────────────────────────────────── */
let db, fcm;
try {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'sabnahis-portal' });
  db  = admin.firestore();
  fcm = admin.messaging();
  console.log('[E-Tuklas] Firebase Admin connected ✓');
} catch(e) {
  console.error('[E-Tuklas] Firebase init failed:', e.message);
  process.exit(1);
}

/* ── WEB PUSH (for iOS Safari PWA native push) ──────────────── */
webpush.setVapidDetails(
  'mailto:admin@sabnahis.edu.ph',
  process.env.VAPID_PUBLIC_KEY  || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

/* ── GET ALL TOKENS & SUBSCRIPTIONS ────────────────────────── */
async function getAllTargets(targetGrades = [], targetSections = []) {
  const snap   = await db.collection('users').get();
  const fcmTokens = [];
  const webSubs   = [];

  snap.forEach(doc => {
    const user = doc.data();

    // Grade filter
    if (targetGrades.length > 0 && !targetGrades.includes(user.grade)) return;
    // Section filter
    if (targetSections.length > 0) {
      const sec = (user.section || '').trim().toLowerCase();
      if (!targetSections.includes(sec)) return;
    }

    // FCM tokens (Android / Chrome)
    if (user.fcmTokens && user.fcmTokens.length) {
      user.fcmTokens.forEach(t => { if (t && t.length > 20) fcmTokens.push(t); });
    }

    // Native web push subscription (iOS Safari PWA)
    if (user.webpushSubscription) {
      try {
        var sub = typeof user.webpushSubscription === 'string'
          ? JSON.parse(user.webpushSubscription)
          : user.webpushSubscription;
        if (sub && sub.endpoint) webSubs.push(sub);
      } catch(e) {}
    }
  });

  return { fcmTokens, webSubs };
}

/* ── SEND PUSH ──────────────────────────────────────────────── */
async function sendPush(title, body, data = {}, targetGrades = [], targetSections = []) {
  const { fcmTokens, webSubs } = await getAllTargets(targetGrades, targetSections);

  console.log(`[FCM] Sending to ${fcmTokens.length} FCM token(s) and ${webSubs.length} iOS subscription(s)...`);

  // ── FCM (Android / Chrome) ────────────────────────────────
  if (fcmTokens.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < fcmTokens.length; i += BATCH) {
      const batch = fcmTokens.slice(i, i + BATCH);
      try {
        const res = await fcm.sendEachForMulticast({
          notification: { title, body },
          data: { title, body, ...data },
          webpush: {
            notification: {
              title, body,
              icon:               '/LOGO.png',
              badge:              '/LOGO.png',
              tag:                data.tag || 'etuklas-notif',
              requireInteraction: data.priority === 'urgent',
              vibrate:            [200, 100, 200],
            },
            fcmOptions: { link: 'https://sabnahis-ste.github.io/' },
          },
          tokens: batch,
        });
        console.log(`[FCM] ✓ ${res.successCount} sent, ✗ ${res.failureCount} failed`);
      } catch(err) {
        console.error('[FCM] Error:', err.message);
      }
    }
  }

  // ── Native Web Push (iOS Safari PWA) ─────────────────────
  if (webSubs.length > 0 && process.env.VAPID_PRIVATE_KEY) {
    const payload = JSON.stringify({ title, body, ...data });
    const results = await Promise.allSettled(
      webSubs.map(sub => webpush.sendNotification(sub, payload))
    );
    const ok   = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    console.log(`[WebPush iOS] ✓ ${ok} sent, ✗ ${fail} failed`);
  } else if (webSubs.length > 0) {
    console.warn('[WebPush iOS] Skipped — VAPID_PRIVATE_KEY not set');
  }
}

/* ── WATCH ANNOUNCEMENTS ────────────────────────────────────── */
const startedAt = Date.now();

db.collection('announcements')
  .orderBy('createdAt', 'desc')
  .limit(1)
  .onSnapshot(snap => {
    snap.docChanges().forEach(async change => {
      if (change.type !== 'added') return;
      const data = change.doc.data();
      if (new Date(data.createdAt).getTime() < startedAt - 10000) return;
      if (data.scheduled && new Date(data.scheduledAt).getTime() > Date.now() + 60000) return;

      const icon  = { urgent:'🚨', important:'❗', normal:'📢' }[data.priority] || '📢';
      const title = `${icon} ${data.title || 'New Announcement'}`;
      const body  = (data.body || '').substring(0, 120);

      console.log(`[Push] New announcement: "${data.title}"`);
      await sendPush(title, body, {
        type: 'announcement', priority: data.priority || 'normal',
        icon, tag: 'etuklas-announcement',
      }, data.targetGrades || [], data.targetSections || []);
    });
  }, err => console.error('[Push] Listener error:', err.message));

/* ── WATCH GRADES ───────────────────────────────────────────── */
db.collection('studies').onSnapshot(snap => {
  snap.docChanges().forEach(async change => {
    if (change.type !== 'modified') return;
    const data = change.doc.data();
    if (!data.grade || data.gradeNotifiedAt) return;

    const authorId = data.authorId || data.userId;
    if (!authorId) return;

    const userDoc = await db.collection('users').doc(authorId).get();
    if (!userDoc.exists) return;
    const user = userDoc.data();

    const title = `⭐ Your study was graded!`;
    const body  = `"${(data.title || 'Your study').substring(0, 60)}" received a grade of ${data.grade}.`;

    const targets = [];
    if (user.fcmTokens)          targets.push(...user.fcmTokens);
    const webSub = user.webpushSubscription
      ? [typeof user.webpushSubscription === 'string'
          ? JSON.parse(user.webpushSubscription)
          : user.webpushSubscription]
      : [];

    console.log(`[Push] Grade notification → ${authorId}`);

    // Send FCM
    if (targets.length > 0) {
      try {
        await fcm.sendEachForMulticast({
          notification: { title, body },
          data: { title, body, type: 'grade', icon: '⭐', tag: 'etuklas-grade' },
          webpush: { notification: { title, body, icon: '/LOGO.png' } },
          tokens: targets,
        });
      } catch(e) { console.error('[FCM] Grade error:', e.message); }
    }

    // Send native web push (iOS)
    if (webSub.length > 0 && process.env.VAPID_PRIVATE_KEY) {
      const payload = JSON.stringify({ title, body, type: 'grade', icon: '⭐' });
      await Promise.allSettled(webSub.map(s => webpush.sendNotification(s, payload)));
    }

    await change.doc.ref.update({ gradeNotifiedAt: new Date().toISOString() });
  });
}, err => console.error('[Push] Studies error:', err.message));

/* ── ROUTES ─────────────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'running', service: 'E-Tuklas Push Server', time: new Date().toISOString() });
});

app.post('/send-test', async (req, res) => {
  try {
    await sendPush('🔔 Test', 'E-Tuklas push notifications are working!', { type: 'test' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── KEEP ALIVE ──────────────────────────────────────────────── */
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
if (RENDER_URL) {
  setInterval(function() {
    require('https').get(RENDER_URL, function() {
      console.log('[Keep-Alive] Ping ✓');
    }).on('error', function(e) {
      console.warn('[Keep-Alive] Failed:', e.message);
    });
  }, 14 * 60 * 1000);
  console.log('[Keep-Alive] Auto-ping enabled ✓');
}

/* ── START ───────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[E-Tuklas] Push server on port ${PORT} ✓`);
  console.log(`[E-Tuklas] Watching Firestore...`);
});
