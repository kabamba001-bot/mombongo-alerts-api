/**
 * api/reset-credentials.js
 * -------------------------------------------------------------------------
 * Outil admin pour un client qui a oublié son code de connexion ou son PIN
 * de verrouillage — remplace l'exécution manuelle du workflow GitHub Actions
 * "Réinitialiser un code de connexion" (reset-phone-code.yml) et l'édition
 * manuelle du champ appLockResetRequested dans la console Firebase, par un
 * simple formulaire ici.
 *
 * Recherche TOUJOURS par numéro de téléphone (jamais par email) : c'est ce
 * que le client donne sur WhatsApp, et c'est la seule vraie identité pour un
 * compte Mombongo (voir phone-auth.js — l'email interne
 * "xxx@phone.mombongo.app" n'est qu'un détail technique, jamais montré à
 * personne). La recherche passe par Firebase Auth directement
 * (getUserByEmail sur l'email interne reconstruit), pas par une requête
 * Firestore sur un champ "email" — plus fiable, puisqu'elle ne dépend
 * d'aucune donnée dupliquée côté Firestore.
 *
 * GET  ?phone=243812345678
 *   -> infos de base du compte (nom, uid), pour confirmer l'identité avant
 *      d'agir. Ne révèle jamais le code ou le PIN actuels (impossible : ni
 *      l'un ni l'autre n'est stocké en clair, voir plus bas).
 *
 * POST ?phone=243812345678&action=reset-code&newCode=ab12
 *   -> réinitialise le CODE DE CONNEXION (numéro+code, phone-auth.js) —
 *      exactement ce que fait scripts/reset-phone-code.js dans l'autre
 *      dépôt. newCode : 4 à 8 caractères, chiffres et/ou lettres.
 *
 * POST ?phone=243812345678&action=reset-pin
 *   -> déclenche la réinitialisation à distance du VERROUILLAGE PAR PIN
 *      (app-lock.js). CE N'EST PAS pareil que reset-code : le PIN n'est
 *      JAMAIS connu du serveur (haché, stocké uniquement en local sur
 *      l'appareil) — impossible techniquement de le "réinitialiser à une
 *      valeur", même pour un admin. Cette action pose seulement le champ
 *      appLockResetRequested=true sur le compte ; chaque appareil lié au
 *      compte (voir applyDocData(), stores-devices.js) le détecte alors en
 *      temps réel et DÉSACTIVE le verrouillage tout seul, sur TOUS ses
 *      appareils à la fois (l'app ne distingue pas encore lequel est
 *      bloqué). Le client peut ensuite se remettre un nouveau code depuis
 *      "Compte" s'il le souhaite. C'est exactement l'étape manuelle déjà
 *      documentée dans app-lock.js — ce fichier l'automatise, rien de plus.
 *
 * Protégé par le même secret que set-vip.js (ADMIN_SECRET) — même niveau de
 * sensibilité (ça aussi, ça change l'accès à un compte).
 *
 * Variables d'environnement Vercel : aucune nouvelle à ajouter — réutilise
 * FIREBASE_SERVICE_ACCOUNT et ADMIN_SECRET, déjà en place pour set-vip.js.
 *
 * Ne touche jamais firestore.rules : ces écritures passent par le SDK Admin
 * (compte de service), qui ignore toujours les règles de sécurité — elles ne
 * s'appliquent qu'aux clients (l'app elle-même), jamais au serveur.
 * -------------------------------------------------------------------------
 */
const admin = require('firebase-admin');

// Doit rester identique à phone-auth.js et reset-phone-code.js — c'est ce
// qui permet de retrouver le bon compte à partir du seul numéro.
const PHONE_AUTH_EMAIL_DOMAIN = 'phone.mombongo.app';
const PHONE_AUTH_PASSWORD_PREFIX = 'Mombongo#';
const PHONE_DEFAULT_COUNTRY_CODE = '243';
const CODE_REGEX = /^[A-Za-z0-9]{4,8}$/;

function initAdmin(){
  if(admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant dans les variables d\'environnement Vercel.');
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

// Identique à normalizePhoneDigits() dans phone-auth.js / reset-phone-code.js.
function normalizePhoneDigits(raw){
  let digits = String(raw || '').replace(/\D/g, '');
  if(digits.startsWith('00')) digits = digits.slice(2);
  if(digits.length === 10 && digits.startsWith('0')){
    digits = PHONE_DEFAULT_COUNTRY_CODE + digits.slice(1);
  }
  return digits;
}

module.exports = async (req, res) => {
  const secret = (req.headers.authorization || '').replace('Bearer ', '');
  if(!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET){
    res.status(401).json({ error: 'Non autorisé' });
    return;
  }

  const phoneRaw = (req.query && req.query.phone) || (req.body && req.body.phone) || '';
  const digits = normalizePhoneDigits(phoneRaw);
  if(digits.length < 8){
    res.status(400).json({ error: "Numéro de téléphone invalide — chiffres uniquement, indicatif du pays inclus (ex: 243812345678)." });
    return;
  }

  try{
    initAdmin();
    const db = admin.firestore();
    const internalEmail = digits + '@' + PHONE_AUTH_EMAIL_DOMAIN;

    let userRecord;
    try{
      userRecord = await admin.auth().getUserByEmail(internalEmail);
    }catch(e){
      res.status(404).json({ error: `Aucun compte trouvé pour le numéro "${digits}". Le client doit s'être inscrit au moins une fois par numéro+code dans Mombongo.` });
      return;
    }
    const uid = userRecord.uid;
    const userDocRef = db.collection('mombongo_users').doc(uid);

    if(req.method === 'GET'){
      const docSnap = await userDocRef.get();
      const data = docSnap.exists ? docSnap.data() : {};
      res.status(200).json({
        ok: true,
        uid,
        phone: digits,
        displayName: data.displayName || userRecord.displayName || null,
        appLockResetRequested: !!data.appLockResetRequested
      });
      return;
    }

    if(req.method === 'POST'){
      const action = (req.query && req.query.action) || (req.body && req.body.action);

      if(action === 'reset-code'){
        const newCode = ((req.query && req.query.newCode) || (req.body && req.body.newCode) || '').trim();
        if(!CODE_REGEX.test(newCode)){
          res.status(400).json({ error: "Code invalide — attendu : 4 à 8 caractères, chiffres et/ou lettres." });
          return;
        }
        await admin.auth().updateUser(uid, { password: PHONE_AUTH_PASSWORD_PREFIX + newCode });
        res.status(200).json({ ok: true, uid, phone: digits, action: 'reset-code', newCode });
        return;
      }

      if(action === 'reset-pin'){
        await userDocRef.set({ appLockResetRequested: true }, { merge: true });
        res.status(200).json({ ok: true, uid, phone: digits, action: 'reset-pin' });
        return;
      }

      res.status(400).json({ error: "Action inconnue — attendu : 'reset-code' ou 'reset-pin'." });
      return;
    }

    res.status(405).json({ error: 'Méthode non supportée' });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
