/**
 * E-TUKLAS STE PORTAL — PUSH NOTIFICATION BACKEND v2.1
 * Fixed: grade watcher startup guard, url in all payloads,
 *        /subscribe endpoint, iOS payload fields
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

/* ── PORTAL URL ─────────────────────────────────────────────── */
const PORTAL_URL = process.env.PORTAL_URL || 'https://sabnahis-ste.github.io/';

/* ── GET ALL TOKENS & SUBSCRIPTIONS ────────────────────────── */
async function getAllTargets(targetGrades = [], targetSections = []) {
  const snap      = await db.collection('users').get();
  const fcmTokens = [];
  const webSubs   = [];

  snap.forEach(doc => {
    const user = doc.data();

    if (targetGrades.length > 0 && !targetGrades.includes(user.grade)) return;
    if (targetSections.length > 0) {
      const sec = (user.section || '').trim().toLowerCase();
      if (!targetSections.includes(sec)) return;
    }

    if (user.fcmTokens && user.fcmTokens.length) {
      user.fcmTokens.forEach(t => { if (t && t.length > 20) fcmTokens.push(t); });
    }

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

  // ✅ FIX: Always include url so notificationclick navigates correctly
  const url = data.url || PORTAL_URL;

  console.log(`[FCM] Sending to ${fcmTokens.length} FCM token(s) and ${webSubs.length} iOS subscription(s)...`);

  // ── FCM (Android / Chrome) ────────────────────────────────
  if (fcmTokens.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < fcmTokens.length; i += BATCH) {
      const batch = fcmTokens.slice(i, i + BATCH);
      try {
        const res = await fcm.sendEachForMulticast({
          notification: { title, body },
          data: { title, body, url, ...data },
          webpush: {
            notification: {
              title, body,
              icon:               '/LOGO.png',
              badge:              '/LOGO.png',
              tag:                data.tag || 'etuklas-notif',
              requireInteraction: data.priority === 'urgent',
              vibrate:            [200, 100, 200],
            },
            fcmOptions: { link: url },
          },
          tokens: batch,
        });
        console.log(`[FCM] ✓ ${res.successCount} sent, ✗ ${res.failureCount} failed`);

        // Clean up invalid tokens
        res.responses.forEach((r, idx) => {
          if (!r.success && r.error &&
              (r.error.code === 'messaging/invalid-registration-token' ||
               r.error.code === 'messaging/registration-token-not-registered')) {
            console.log(`[FCM] Removing stale token: ${batch[idx].substring(0, 20)}...`);
            // Best-effort cleanup — find and remove from Firestore
            db.collection('users')
              .where('fcmTokens', 'array-contains', batch[idx])
              .get()
              .then(snap => snap.forEach(doc =>
                doc.ref.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(batch[idx]) })
              ))
              .catch(() => {});
          }
        });
      } catch(err) {
        console.error('[FCM] Error:', err.message);
      }
    }
  }

  // ── Native Web Push (iOS Safari PWA) ─────────────────────
  if (webSubs.length > 0 && process.env.VAPID_PRIVATE_KEY) {
    // ✅ FIX: Include url and tag in iOS payload so SW can use them
    const payload = JSON.stringify({
      title,
      body,
      url,
      tag:      data.tag      || 'etuklas-notif',
      priority: data.priority || 'normal',
      type:     data.type     || 'general',
      icon:     data.icon     || null,
    });

    const results = await Promise.allSettled(
      webSubs.map(sub =>
        webpush.sendNotification(sub, payload).catch(err => {
          // ✅ FIX: Clean up expired iOS subscriptions (410 Gone)
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log('[WebPush iOS] Removing expired subscription');
            db.collection('users')
              .where('webpushSubscription.endpoint', '==', sub.endpoint)
              .get()
              .then(snap => snap.forEach(doc =>
                doc.ref.update({ webpushSubscription: admin.firestore.FieldValue.delete() })
              ))
              .catch(() => {});
          }
          throw err;
        })
      )
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
        type:     'announcement',
        priority: data.priority || 'normal',
        icon,
        tag:      'etuklas-announcement',
        url:      PORTAL_URL,
      }, data.targetGrades || [], data.targetSections || []);
    });
  }, err => console.error('[Push] Listener error:', err.message));

/* ── WATCH GRADES ───────────────────────────────────────────── */
// ✅ FIX: Added startedAt guard to prevent re-firing on server restart
db.collection('studies').onSnapshot(snap => {
  snap.docChanges().forEach(async change => {
    if (change.type !== 'modified') return;
    const data = change.doc.data();

    // Skip if already notified
    if (!data.grade || data.gradeNotifiedAt) return;

    // ✅ FIX: Skip docs that were graded before this server instance started
    if (data.gradedAt && new Date(data.gradedAt).getTime() < startedAt - 10000) return;

    const authorId = data.authorId || data.userId;
    if (!authorId) return;

    const userDoc = await db.collection('users').doc(authorId).get();
    if (!userDoc.exists) return;
    const user = userDoc.data();

    const title = `⭐ Your study was graded!`;
    const body  = `"${(data.title || 'Your study').substring(0, 60)}" received a grade of ${data.grade}.`;
    // ✅ FIX: Include url in grade notification
    const url   = PORTAL_URL;

    const fcmTargets = user.fcmTokens || [];
    const webSub = user.webpushSubscription
      ? [typeof user.webpushSubscription === 'string'
          ? JSON.parse(user.webpushSubscription)
          : user.webpushSubscription]
      : [];

    console.log(`[Push] Grade notification → ${authorId}`);

    // Send FCM
    if (fcmTargets.length > 0) {
      try {
        await fcm.sendEachForMulticast({
          notification: { title, body },
          data: { title, body, url, type: 'grade', icon: '⭐', tag: 'etuklas-grade' },
          webpush: {
            notification: { title, body, icon: '/LOGO.png' },
            fcmOptions:   { link: url },
          },
          tokens: fcmTargets,
        });
      } catch(e) { console.error('[FCM] Grade error:', e.message); }
    }

    // Send native web push (iOS)
    if (webSub.length > 0 && process.env.VAPID_PRIVATE_KEY) {
      // ✅ FIX: Include url and tag in iOS grade payload
      const payload = JSON.stringify({
        title, body, url,
        type: 'grade',
        icon: '⭐',
        tag:  'etuklas-grade',
      });
      await Promise.allSettled(webSub.map(s => webpush.sendNotification(s, payload)));
    }

    await change.doc.ref.update({ gradeNotifiedAt: new Date().toISOString() });
  });
}, err => console.error('[Push] Studies error:', err.message));

/* ── ROUTES ─────────────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'running', service: 'E-Tuklas Push Server v2.1', time: new Date().toISOString() });
});

app.post('/send-test', async (req, res) => {
  try {
    await sendPush('🔔 Test', 'E-Tuklas push notifications are working!', {
      type: 'test',
      tag:  'etuklas-test',
      url:  PORTAL_URL,
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── ✅ NEW: /subscribe — save iOS web push subscription ─────── */
app.post('/subscribe', async (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'userId and subscription required' });
  }
  try {
    await db.collection('users').doc(userId).update({
      webpushSubscription: subscription,
    });
    console.log(`[WebPush] Saved subscription for user: ${userId}`);
    res.json({ success: true });
  } catch(e) {
    console.error('[WebPush] Save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── ✅ NEW: /unsubscribe — remove iOS web push subscription ─── */
app.post('/unsubscribe', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await db.collection('users').doc(userId).update({
      webpushSubscription: admin.firestore.FieldValue.delete(),
    });
    console.log(`[WebPush] Removed subscription for user: ${userId}`);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
  console.log(`[E-Tuklas] Portal URL: ${PORTAL_URL}`);
  console.log(`[E-Tuklas] Watching Firestore...`);
});
