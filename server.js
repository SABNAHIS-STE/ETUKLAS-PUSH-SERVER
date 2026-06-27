/**
 * E-TUKLAS STE PORTAL — PUSH NOTIFICATION BACKEND
 * Runs FREE on Render.com — no credit card needed.
 * Uses Firebase Admin SDK only — no VAPID private key needed.
 */

const express = require('express');
const admin   = require('firebase-admin');
const app     = express();
app.use(express.json());

/* ── FIREBASE ADMIN INIT ──────────────────────────────────── */
let db, fcm;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  'sabnahis-portal'
  });
  db  = admin.firestore();
  fcm = admin.messaging();
  console.log('[E-Tuklas] Firebase Admin connected ✓');
} catch(e) {
  console.error('[E-Tuklas] Firebase init failed:', e.message);
  process.exit(1);
}

/* ── GET ALL FCM TOKENS ───────────────────────────────────── */
async function getAllTokens(targetGrades = [], targetSections = []) {
  const snap = await db.collection('users').get();
  const tokens = [];
  snap.forEach(doc => {
    const user = doc.data();
    if (!user.fcmTokens || !user.fcmTokens.length) return;
    if (targetGrades.length > 0 && !targetGrades.includes(user.grade)) return;
    if (targetSections.length > 0) {
      const sec = (user.section || '').trim().toLowerCase();
      if (!targetSections.includes(sec)) return;
    }
    user.fcmTokens.forEach(t => { if (t && t.length > 20) tokens.push(t); });
  });
  return tokens;
}

/* ── SEND FCM PUSH ────────────────────────────────────────── */
async function sendPush(tokens, title, body, data = {}) {
  if (!tokens.length) {
    console.log('[FCM] No tokens — no students have allowed notifications yet.');
    return;
  }

  const staleTokens = new Set();
  const BATCH = 500;

  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const message = {
      notification: { title, body },
      data: { title, body, ...data },
      webpush: {
        notification: {
          title,
          body,
          icon:               '/LOGO.png',
          badge:              '/LOGO.png',
          tag:                data.tag || 'etuklas-notif',
          requireInteraction: data.priority === 'urgent',
          vibrate:            [200, 100, 200],
          actions: [
            { action: 'view',    title: '👁 View'    },
            { action: 'dismiss', title: '✕ Dismiss' },
          ],
        },
        fcmOptions: { link: 'https://sabnahis-ste.github.io/' },
      },
      tokens: batch,
    };

    try {
      const res = await fcm.sendEachForMulticast(message);
      console.log(`[FCM] ✓ ${res.successCount} sent, ✗ ${res.failureCount} failed`);
      res.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
          ) staleTokens.add(batch[idx]);
        }
      });
    } catch(err) {
      console.error('[FCM] Batch error:', err.message);
    }
  }

  // Clean up stale tokens
  if (staleTokens.size > 0) {
    console.log(`[FCM] Removing ${staleTokens.size} stale token(s)...`);
    const usersSnap = await db.collection('users').get();
    const batchWrite = db.batch();
    usersSnap.forEach(doc => {
      const user = doc.data();
      if (!user.fcmTokens) return;
      const cleaned = user.fcmTokens.filter(t => !staleTokens.has(t));
      if (cleaned.length !== user.fcmTokens.length)
        batchWrite.update(doc.ref, { fcmTokens: cleaned });
    });
    await batchWrite.commit();
  }
}

/* ── WATCH ANNOUNCEMENTS ──────────────────────────────────── */
const startedAt = Date.now();

db.collection('announcements')
  .orderBy('createdAt', 'desc')
  .limit(1)
  .onSnapshot(snap => {
    snap.docChanges().forEach(async change => {
      if (change.type !== 'added') return;
      const data = change.doc.data();

      // Ignore old announcements that existed before server started
      if (new Date(data.createdAt).getTime() < startedAt - 10000) return;

      // Skip future-scheduled ones
      if (data.scheduled && data.scheduledAt) {
        if (new Date(data.scheduledAt).getTime() > Date.now() + 60000) return;
      }

      const icon  = { urgent:'🚨', important:'❗', normal:'📢' }[data.priority] || '📢';
      const title = `${icon} ${data.title || 'New Announcement'}`;
      const body  = (data.body || '').substring(0, 120);

      console.log(`[FCM] New announcement: "${data.title}" — sending push...`);

      try {
        const tokens = await getAllTokens(data.targetGrades || [], data.targetSections || []);
        console.log(`[FCM] Sending to ${tokens.length} device(s)...`);
        await sendPush(tokens, title, body, {
          type:     'announcement',
          priority: data.priority || 'normal',
          icon,
          tag:      'etuklas-announcement',
        });
      } catch(err) {
        console.error('[FCM] Announcement push error:', err.message);
      }
    });
  }, err => console.error('[FCM] Listener error:', err.message));

/* ── WATCH GRADES ─────────────────────────────────────────── */
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
    if (!user.fcmTokens || !user.fcmTokens.length) return;

    const title = `⭐ Your study was graded!`;
    const body  = `"${(data.title || 'Your study').substring(0, 60)}" received a grade of ${data.grade}.`;

    console.log(`[FCM] Grade notification → user ${authorId}`);
    try {
      await sendPush(user.fcmTokens, title, body, { type:'grade', icon:'⭐', tag:'etuklas-grade' });
      await change.doc.ref.update({ gradeNotifiedAt: new Date().toISOString() });
    } catch(err) {
      console.error('[FCM] Grade push error:', err.message);
    }
  });
}, err => console.error('[FCM] Studies listener error:', err.message));

/* ── ROUTES ───────────────────────────────────────────────── */
app.get('/', (req, res) => {
  res.json({ status: 'running', service: 'E-Tuklas Push Server', time: new Date().toISOString() });
});

app.post('/send-test', async (req, res) => {
  try {
    const tokens = await getAllTokens();
    await sendPush(tokens, '🔔 Test Notification', 'E-Tuklas push notifications are working!', { type:'test' });
    res.json({ success: true, tokenCount: tokens.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── START ────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[E-Tuklas] Push server running on port ${PORT} ✓`);
  console.log(`[E-Tuklas] Watching Firestore for announcements & grades...`);
});
