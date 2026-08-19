/**
 * api/set-vip.js
 * -------------------------------------------------------------------------
 * Outil admin pour gérer le statut VIP (legacy) ET/OU le palier Mombongo
 * (Simple/Business/Pro) sans passer par la console Firebase.
 *
 * GET  ?email=xxx
 *   -> renvoie le statut VIP legacy ET le palier actuel de ce compte.
 *
 * POST ?email=xxx&until=AAAA-MM-JJ
 *   -> met à jour vipUntil (legacy) pour ce compte — comportement INCHANGÉ,
 *      volontairement laissé tel quel même si l'app ne lit plus ce champ
 *      nulle part (voir PALIERS.md) : certains outils externes peuvent
 *      encore s'appuyer dessus, autant ne rien casser.
 *
 * POST ?email=xxx&plan=business&days=30
 *   -> NOUVEAU : active un palier Mombongo directement — écrit userPlan,
 *      userPlanStatus:'active', userPlanExpiresAt (maintenant + days jours),
 *      userPlanTrialEndsAt:null. `plan` vaut 'simple', 'business' ou 'pro'.
 *      C'est CE mécanisme, pas vipUntil, que l'app lit réellement pour
 *      déterminer ce à quoi un compte a droit (voir plans.js côté app).
 *
 * Les deux updates (`until` et `plan`+`days`) peuvent être envoyés dans le
 * même appel POST, ou séparément — chacun ne touche que ses propres champs.
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
        // Legacy — conservé tel quel, plus lu par l'app (voir PALIERS.md).
        vipUntil: data.vipUntil || null,
        // Le vrai palier utilisé par l'app.
        userPlan: data.userPlan || 'simple',
        userPlanStatus: data.userPlanStatus || 'free',
        userPlanExpiresAt: data.userPlanExpiresAt || null,
        userPlanTrialEndsAt: data.userPlanTrialEndsAt || null
      });
      return;
    }

    if(req.method === 'POST'){
      const until = (req.query && req.query.until) || (req.body && req.body.until);
      const plan = (req.query && req.query.plan) || (req.body && req.body.plan);
      const days = (req.query && req.query.days) || (req.body && req.body.days);

      if(!until && !plan){
        res.status(400).json({ error: "Rien à mettre à jour — fournis 'until' (VIP legacy) et/ou 'plan' + 'days' (palier)." });
        return;
      }

      const update = {};
      const responsePayload = { ok: true, uid: userDoc.id, email: data.email || email };

      // Chemin VIP legacy — INCHANGÉ.
      if(until){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(until)){
          res.status(400).json({ error: 'Date VIP invalide, format attendu AAAA-MM-JJ' });
          return;
        }
        update.vipUntil = until;
        responsePayload.vipUntil = until;
      }

      // Nouveau chemin palier.
      if(plan){
        if(!VALID_PLANS.includes(plan)){
          res.status(400).json({ error: `Palier invalide — attendu : ${VALID_PLANS.join(', ')}` });
          return;
        }
        const daysNum = parseInt(days, 10);
        if(!daysNum || daysNum <= 0){
          res.status(400).json({ error: 'Nombre de jours invalide pour le palier (attendu un entier positif).' });
          return;
        }
        const expiresAt = Date.now() + daysNum * 24 * 60 * 60 * 1000;
        update.userPlan = plan;
        update.userPlanStatus = 'active';
        update.userPlanExpiresAt = expiresAt;
        update.userPlanTrialEndsAt = null;
        responsePayload.userPlan = plan;
        responsePayload.userPlanExpiresAt = expiresAt;
      }

      await userDoc.ref.set(update, { merge: true });
      res.status(200).json(responsePayload);
      return;
    }

    res.status(405).json({ error: 'Méthode non supportée' });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
