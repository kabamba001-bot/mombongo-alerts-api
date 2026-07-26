/**
 * api/set-vip.js
 * -------------------------------------------------------------------------
 * Outil admin pour gérer le statut VIP sans passer par la console Firebase.
 *
 * GET  ?email=xxx           -> renvoie le statut VIP actuel de ce compte
 * POST ?email=xxx&until=AAAA-MM-JJ  -> met à jour vipUntil pour ce compte
 *
 * Protégé par un secret séparé de celui du cron (ADMIN_SECRET), volontairement
 * différent : cette fonction peut modifier le statut payant d'un compte, donc
 * elle mérite son propre mot de passe, indépendant de celui utilisé par
 * cron-job.org pour les alertes.
 *
 * Variables d'environnement à définir dans Vercel :
 *   - FIREBASE_SERVICE_ACCOUNT : déjà en place (même clé que les autres fonctions)
 *   - ADMIN_SECRET : un mot de passe que tu inventes, différent de CRON_SECRET
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');

function initAdmin(){
  if(admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant dans les variables d\'environnement Vercel.');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

module.exports = async (req, res) => {
  const secret = (req.headers.authorization || '').replace('Bearer ', '');
  if(!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET){
    res.status(401).json({ error: 'Non autorisé' });
    return;
  }

  const email = ((req.query && req.query.email) || (req.body && req.body.email) || '').trim().toLowerCase();
  if(!email){ res.status(400).json({ error: 'Email manquant' }); return; }

  try{
    initAdmin();
    const db = admin.firestore();

    const snap = await db.collection('mombongo_users').where('email', '==', email).get();
    if(snap.empty){
      res.status(404).json({ error: 'Aucun compte trouvé avec cet email' });
      return;
    }
    if(snap.size > 1){
      res.status(409).json({ error: `${snap.size} comptes trouvés avec cet email — action annulée par sécurité, vérifie manuellement` });
      return;
    }
    const userDoc = snap.docs[0];
    const data = userDoc.data();

    if(req.method === 'GET'){
      res.status(200).json({
        ok: true,
        uid: userDoc.id,
        email: data.email || null,
        displayName: data.displayName || null,
        vipUntil: data.vipUntil || null
      });
      return;
    }

    if(req.method === 'POST'){
      const until = (req.query && req.query.until) || (req.body && req.body.until);
      if(!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)){
        res.status(400).json({ error: 'Date invalide, format attendu AAAA-MM-JJ' });
        return;
      }
      await userDoc.ref.set({ vipUntil: until }, { merge: true });
      res.status(200).json({ ok: true, uid: userDoc.id, email: data.email || email, vipUntil: until });
      return;
    }

    res.status(405).json({ error: 'Méthode non supportée' });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
