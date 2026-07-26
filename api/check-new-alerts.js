/**
 * api/check-new-alerts.js
 * -------------------------------------------------------------------------
 * Fonction serverless (Vercel) appelée par un service de cron externe
 * (cron-job.org) toutes les quelques minutes, à la place du workflow
 * GitHub Actions qui n'était pas fiable en dessous d'1h.
 *
 * Reprend exactement la même logique que send-new-alerts.js : ne notifie
 * que les NOUVELLES alertes (comparaison avec notifState dans Firestore).
 *
 * Protégée par un secret partagé (CRON_SECRET) passé en query param ou en
 * en-tête Authorization, pour empêcher n'importe qui d'appeler l'URL et de
 * déclencher des envois.
 *
 * Variables d'environnement à définir dans Vercel :
 *   - FIREBASE_SERVICE_ACCOUNT : le JSON complet de la clé de compte de service
 *   - CRON_SECRET : une chaîne secrète que tu inventes toi-même
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');

const EXPIRY_WARNING_DAYS = 10;

function initAdmin(){
  if(admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant dans les variables d\'environnement Vercel.');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function daysUntilExpiry(expiryDate){
  if(!expiryDate) return Infinity;
  const exp = new Date(expiryDate + 'T00:00:00');
  const now = new Date();
  now.setHours(0,0,0,0);
  return Math.floor((exp - now) / 86400000);
}

function computeStoreAlerts(storeData){
  const products = (storeData && storeData.products) || [];
  const todayStr = new Date().toISOString().slice(0,10);

  const lowStock = products.filter(p => typeof p.qty === 'number' && typeof p.threshold === 'number' && p.qty <= p.threshold);
  const expired = products.filter(p => p.expiryDate && p.expiryDate < todayStr);
  const expiringSoon = products.filter(p => p.expiryDate && p.expiryDate >= todayStr && daysUntilExpiry(p.expiryDate) <= EXPIRY_WARNING_DAYS);

  const alertKeys = new Set();
  lowStock.forEach(p => alertKeys.add(`low:${p.id}`));
  expired.forEach(p => alertKeys.add(`exp:${p.id}`));
  expiringSoon.forEach(p => alertKeys.add(`soon:${p.id}`));

  return { alertKeys, lowStock, expired, expiringSoon };
}

function buildMessage(storeName, lowStock, expired, expiringSoon){
  const parts = [];
  if(lowStock.length) parts.push(`${lowStock.length} produit${lowStock.length>1?'s':''} en stock faible`);
  if(expired.length) parts.push(`${expired.length} produit${expired.length>1?'s':''} périmé${expired.length>1?'s':''}`);
  if(expiringSoon.length) parts.push(`${expiringSoon.length} produit${expiringSoon.length>1?'s':''} qui expire${expiringSoon.length>1?'nt':''} bientôt`);
  const body = parts.join(', ');
  const title = `⚠️ ${storeName || 'Ta boutique'}`;
  return { title, body };
}

module.exports = async (req, res) => {
  const secret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if(!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET){
    res.status(401).json({ error: 'Non autorisé' });
    return;
  }

  try{
    initAdmin();
    const db = admin.firestore();

    const usersSnap = await db.collection('mombongo_users').get();
    let notificationsSent = 0;
    const summary = [];

    for(const userDoc of usersSnap.docs){
      const ownerUid = userDoc.id;
      const data = userDoc.data();
      const stores = data.stores || [];
      const storesData = data.storesData || {};
      if(stores.length === 0) continue;

      const tokensSnap = await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').get();
      if(tokensSnap.empty) continue;
      const tokens = tokensSnap.docs.map(d => ({ id: d.id, token: d.data().token })).filter(t => t.token);
      if(tokens.length === 0) continue;

      for(const store of stores){
        const storeId = store.id;
        const storeData = storesData[storeId];
        if(!storeData) continue;

        const { alertKeys, lowStock, expired, expiringSoon } = computeStoreAlerts(storeData);

        const stateRef = db.collection('mombongo_users').doc(ownerUid).collection('notifState').doc(storeId);
        const stateDoc = await stateRef.get();
        const previousKeys = new Set((stateDoc.exists && stateDoc.data().alertKeys) || []);

        const newKeys = [...alertKeys].filter(k => !previousKeys.has(k));
        await stateRef.set({ alertKeys: [...alertKeys], updatedAt: Date.now() });

        if(newKeys.length === 0) continue;

        const newLow = lowStock.filter(p => newKeys.includes(`low:${p.id}`));
        const newExp = expired.filter(p => newKeys.includes(`exp:${p.id}`));
        const newSoon = expiringSoon.filter(p => newKeys.includes(`soon:${p.id}`));
        const { title, body } = buildMessage(store.name, newLow, newExp, newSoon);

        const message = {
          notification: { title, body },
          data: { storeId: String(storeId), tag: `mombongo-${storeId}` },
          tokens: tokens.map(t => t.token)
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        notificationsSent += response.successCount;
        summary.push(`${store.name}: ${response.successCount}/${tokens.length}`);

        const invalidTokenDocIds = [];
        response.responses.forEach((r, i) => {
          if(!r.success){
            const code = r.error && r.error.code;
            if(code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token'){
              invalidTokenDocIds.push(tokens[i].id);
            }
          }
        });
        for(const docId of invalidTokenDocIds){
          await db.collection('mombongo_users').doc(ownerUid).collection('fcmTokens').doc(docId).delete();
        }
      }
    }

    res.status(200).json({ ok: true, usersChecked: usersSnap.size, notificationsSent, summary });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
