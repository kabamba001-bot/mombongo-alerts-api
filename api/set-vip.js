/**
 * api/set-vip.js
 * -------------------------------------------------------------------------
 * Outil admin pour activer un palier Mombongo (Simple/Business/Pro) sur un
 * compte, sans passer par la console Firebase.
 *
 * GET  ?email=xxx
 *   -> renvoie le palier actuel de ce compte.
 *
 * POST ?email=xxx&plan=business&date=2026-09-18
 *   -> active un palier Mombongo directement — écrit userPlan,
 *      userPlanStatus:'active', userPlanExpiresAt (fin de journée pour la
 *      date fournie), userPlanTrialEndsAt:null. `plan` vaut 'simple',
 *      'business' ou 'pro'. C'est ce mécanisme que l'app lit réellement pour
 *      déterminer ce à quoi un compte a droit (voir plans.js côté app).
 *      `date` peut être dans le passé — c'est volontaire : c'est le moyen le
 *      plus simple de retirer un palier accordé par erreur, sans toucher au
 *      reste des données du compte (stock, ventes...).
 *
 * L'ancien champ `vipUntil` (VIP legacy) a été entièrement retiré de cet
 * outil — l'app ne le lit plus nulle part depuis le passage complet au
 * système de paliers, ça n'avait donc plus de sens de pouvoir encore
 * l'écrire ou l'afficher ici (voir PALIERS.md).
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

const VALID_PLANS = ['simple', 'business', 'pro'];

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
        userPlan: data.userPlan || 'simple',
        userPlanStatus: data.userPlanStatus || 'free',
        userPlanExpiresAt: data.userPlanExpiresAt || null,
        userPlanTrialEndsAt: data.userPlanTrialEndsAt || null
      });
      return;
    }

    if(req.method === 'POST'){
      const plan = (req.query && req.query.plan) || (req.body && req.body.plan);
      const date = (req.query && req.query.date) || (req.body && req.body.date);

      if(!plan){
        res.status(400).json({ error: "Rien à mettre à jour — fournis 'plan' + 'date'." });
        return;
      }
      if(!VALID_PLANS.includes(plan)){
        res.status(400).json({ error: `Palier invalide — attendu : ${VALID_PLANS.join(', ')}` });
        return;
      }
      // Format attendu : YYYY-MM-DD. Une date passée est volontairement acceptée
      // (c'est ce qui permet d'expulser un compte d'un palier accordé par erreur).
      if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)){
        res.status(400).json({ error: "Date invalide — attendu au format AAAA-MM-JJ." });
        return;
      }
      const expiresAt = new Date(date + 'T23:59:59').getTime();
      if(Number.isNaN(expiresAt)){
        res.status(400).json({ error: "Date invalide." });
        return;
      }
      const update = {
        userPlan: plan,
        userPlanStatus: 'active',
        userPlanExpiresAt: expiresAt,
        userPlanTrialEndsAt: null
      };
      await userDoc.ref.set(update, { merge: true });
      res.status(200).json({ ok: true, uid: userDoc.id, email: data.email || email, userPlan: plan, userPlanExpiresAt: expiresAt });
      return;
    }

    res.status(405).json({ error: 'Méthode non supportée' });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
